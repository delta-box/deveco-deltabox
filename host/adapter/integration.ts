// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import type { HostInput, HostHooks, CommandOutput } from "./host"
import { loadConfig, type Config } from "./config"
import { Runtime, type RuntimeHost } from "./runtime"
import { makeTools } from "./tools"
import { createLanguage, type MountedLanguage } from "./language"
import { Project } from "@/project/project"
import { Schema } from "effect"

export const COMMANDS = {
  "sandbox-status": "Show Deltabox session and filesystem status",
  "sandbox-review": "Show pending changes",
  "sandbox-commit": "Accept all pending changes",
  "sandbox-abort": "Roll back the active review",
  "sandbox-skip": "Keep changes pending and preserve the rollback point",
  "sandbox-diff": "Show checkpoint diff: [from] [to]",
  "sandbox-mode": "Set change notification timing: task|tool|risky",
  "sandbox-confirmation": "Show or set review confirmation: command|dialog",
}

const SAFE_HOST_TOOLS = new Set([
  "invalid",
  "question",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
  "skill",
  "task",
  "plan_enter",
  "plan_exit",
])
// These tools either spawn a host process, write directly, or change the project root.
const UNSUPPORTED = [
  "arkts_check",
  "verify_ui",
  "get_ui_verification_log",
  "save_ui_screenshot",
  "compare_images",
  "recognize_ui_components",
  "switch_cwd",
  "plan_write",
  "batch",
]

type Rules =
  | "ask"
  | "allow"
  | "deny"
  | Record<string, "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">>
// DevEco supports arbitrary permission keys, while the SDK v1 type still lists
// only legacy built-ins. Keep this compatibility boundary local to config.
type PermissionConfig = { permission?: Rules; agent?: Record<string, { permission?: Rules } | undefined> }

export interface Dependencies {
  config(project: string): Config
  runtime(project: string, config: Config, host: RuntimeHost, language?: MountedLanguage): Runtime
  platform: string
}

export async function createPlugin(
  input: HostInput,
  dependencies: Dependencies = {
    config: loadConfig,
    runtime: (p, c, host, language) => new Runtime(p, c, host, undefined, language),
    platform: process.platform,
  },
): Promise<HostHooks> {
  const notify = async (message: string, warning = false) => {
    // No TUI in headless hosts. Notification failure must not change a review decision.
    try {
      await input.client.tui.showToast({ body: { title: "Deltabox", message, variant: warning ? "warning" : "info" } })
    } catch {
      /* /sandbox-status and tool results remain available. */
    }
  }
  let language: MountedLanguage | undefined
  let runtime: Runtime | undefined
  let failure: unknown
  let disposed = false
  const idle = new Set<string>()
  const getRuntime = () => {
    if (disposed) throw new Error("Deltabox plugin is disposed")
    if (failure) throw failure
    if (!runtime) {
      try {
        if (!["darwin", "linux", "win32"].includes(dependencies.platform))
          throw new Error(`Deltabox does not support ${dependencies.platform}`)
        if (
          input.experimental_capabilities?.sessionStopping !== 1 ||
          input.experimental_capabilities?.commandResult !== 1 ||
          input.experimental_capabilities?.shellEnv !== 1
        ) {
          throw new Error(
            "Deltabox requires sessionStopping, commandResult and shellEnv v1 host capabilities. No project tool was executed.",
          )
        }
        runtime = dependencies.runtime(
          input.directory,
          dependencies.config(input.directory),
          {
            shell: input.shell,
            ripgrep: input.ripgrep,
            notify,
            async parent(id) {
              const response = await input.client.session.get({
                path: { id },
                query: { directory: input.directory },
                throwOnError: true,
              })
              if (!response.data) throw new Error(`Cannot resolve DevEco session ${id}`)
              return response.data.parentID
            },
          },
          language,
        )
      } catch (error) {
        failure = error
        throw error
      }
    }
    return runtime
  }
  const tools = makeTools(getRuntime)
  const allowed = (name: string) => Object.hasOwn(tools, name) || SAFE_HOST_TOOLS.has(name)

  return {
    tool: tools,
    async config(config) {
      const project = Schema.decodeUnknownSync(Project.Info)(
        Object.fromEntries(Object.entries(input.project).filter(([, value]) => value !== undefined)),
      )
      language = createLanguage(
        {
          directory: input.directory,
          worktree: input.worktree,
          project: { ...project, sandboxes: [...project.sandboxes] },
        },
        { lsp: config.lsp, formatter: config.formatter },
      )
      config.command ??= {}
      for (const [name, description] of Object.entries(COMMANDS)) {
        config.command[name] = { description, template: "Execute the user's Deltabox command. $ARGUMENTS" }
      }
      const current = config as unknown as PermissionConfig
      const permission =
        typeof current.permission === "object"
          ? current.permission
          : current.permission
            ? { "*": current.permission }
            : {}
      current.permission = {
        ...permission,
        deltabox_review: "ask",
        ...Object.fromEntries(UNSUPPORTED.map((name) => [name, "deny" as const])),
      }
      for (const agent of Object.values(current.agent ?? {})) {
        if (!agent) continue
        const rules =
          typeof agent.permission === "object" ? agent.permission : agent.permission ? { "*": agent.permission } : {}
        agent.permission = { ...rules, deltabox_review: "ask" }
      }
      // Language services use the mounted view; Git snapshots still target the host tree.
      config.snapshot = false
    },
    async "tool.execute.before"(call, output) {
      // MCP servers own execution; their existing host permission checks still apply.
      if (call.source === "mcp") return
      // Initialize here, not at plugin import: DevEco logs and skips failed plugins.
      // Returning guards first ensures invalid config/native failures do not enable host tools.
      getRuntime()
      if (call.tool === "task" && output.args?.background)
        throw new Error("Deltabox supports foreground subagents only; omit background or set it to false.")
      if (!allowed(call.tool))
        throw new Error(
          `Tool ${call.tool} has no Deltabox adapter and is disabled. Use the Deltabox shell (including devecocli), read/write/edit/search or apply_patch tools.`,
        )
    },
    async "command.execute.before"(command, output) {
      if (!Object.hasOwn(COMMANDS, command.command)) return
      const text = await getRuntime().command(command.sessionID, command.command, command.arguments)
      await notify(text)
      ;(output as CommandOutput).result = { text }
    },
    async "session.turn.stopping"(context) {
      await runtime?.stopping(context)
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(
        "Project shell, read, write, edit, spec_write, apply_patch, glob, grep, find and list tools use Deltabox. " +
          "The shell uses DevEco's configured shell; use its syntax and shell workdir inside the project. Invoke HarmonyOS tools as devecocli commands through shell. " +
          "Native commands have a fixed 600000 ms deadline and do not support background jobs or stdin. " +
          "MCP tools execute through their own servers outside Deltabox; sandbox review and rollback do not cover their effects. " +
          "By default, changes remain pending for manual slash-command review without approval dialogs. Users can enable dialog confirmation with /sandbox-confirmation dialog. task mode reviews at the end of the root turn; tool/risky modes also review after modifying tools. sandbox_review only inspects pending changes. " +
          "Do not invoke deltabox commands yourself to commit or abort. User slash commands /sandbox-status, /sandbox-review, /sandbox-commit, /sandbox-abort, /sandbox-skip, /sandbox-diff, /sandbox-mode and /sandbox-confirmation manage the session.",
      )
    },
    async event({ event }) {
      // Runtime bus events are newer than the SDK's legacy Event union.
      const value = event as unknown as { type: string; properties: any }
      runtime?.gate.event(value)
      try {
        if (value.type === "session.status" && value.properties.status.type !== "idle")
          idle.delete(value.properties.sessionID)
        const finished =
          value.type === "session.idle" || (value.type === "session.status" && value.properties.status.type === "idle")
        if (finished && !idle.has(value.properties.sessionID)) {
          idle.add(value.properties.sessionID)
          await runtime?.idle(value.properties.sessionID)
        }
        if (value.type === "session.deleted") await runtime?.close(value.properties.info.id)
        if (value.type === "server.instance.disposed") {
          disposed = true
          await runtime?.dispose()
        }
      } catch (error) {
        await notify(`Deltabox: ${String(error)}`, true)
      }
    },
    async dispose() {
      disposed = true
      await runtime?.dispose()
    },
  }
}
