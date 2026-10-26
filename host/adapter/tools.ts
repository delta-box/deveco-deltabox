// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { NativeExecResult } from "deltabox-lite"
import type { Runtime } from "./runtime"
import { applyPatch, decodeText } from "./patch"
import { fileDiff } from "./file-diff"
import type { HostContext } from "./host"
import { operations } from "@/tool/lsp"

const z = tool.schema
const LIMIT = 50 * 1024
function bounded(text: string): string {
  return text.length > LIMIT ? text.slice(0, LIMIT) + "\n[Output truncated; narrow the request.]" : text
}
function result(value: NativeExecResult, allowNoMatches = false): string {
  if (allowNoMatches && value.exit_code === 1) return "No matches."
  const output = [
    value.stdout,
    value.stderr,
    value.exit_code === 0 ? "" : `Exit code: ${value.exit_code ?? "terminated"}`,
    value.truncated ? "[Command output truncated]" : "",
  ]
    .filter(Boolean)
    .join("\n")
  if (allowNoMatches && value.exit_code !== 0) throw new Error(bounded(output))
  return bounded(output || "(no output)")
}

export function makeTools(getRuntime: () => Runtime): Record<string, ToolDefinition> {
  const shell = tool({
    description:
      "Run a foreground command through Deltabox using DevEco's configured shell on Windows or Bash on POSIX, including devecocli commands. Use relative project paths. The native runtime has a fixed 600-second deadline; no PTY, stdin or background jobs. Changes remain reviewable.",
    args: {
      command: z.string(),
      description: z.string().optional(),
      workdir: z.string().optional(),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only 600000 ms is supported; omit to use the runtime deadline"),
    },
    execute: (args, ctx) => {
      if (args.timeout !== undefined && args.timeout !== 600_000)
        throw new Error("Deltabox has a fixed 600000 ms command deadline. Omit timeout or use 600000.")
      const rt = getRuntime()
      const cwd = rt.path(args.workdir ?? ".")
      return rt.tool(ctx, true, "shell", async (client) => {
        const env = await (ctx as HostContext).shellEnv?.(cwd)
        const value = await client.exec(["bash", "-c", args.command], cwd, args.description ?? "shell", env)
        return {
          title: args.description ?? "shell",
          output: result(value),
          metadata: { output: result(value), exit: value.exit_code, description: args.description ?? "shell" },
        }
      })
    },
  })
  const write = tool({
    description: "Write UTF-8 content in the Deltabox project. Pending writes can be reviewed, committed or aborted.",
    args: { filePath: z.string(), content: z.string() },
    execute: (args, ctx) => {
      const rt = getRuntime()
      const path = rt.path(args.filePath)
      return rt.tool(ctx, true, "write", async (client) => {
        const exists = await client.exec(["test", "-e", path])
        if (exists.exit_code !== 0 && exists.exit_code !== 1)
          throw new Error(exists.stderr || "Cannot inspect write target")
        const previous = exists.exit_code === 0 ? await client.read(path) : undefined
        await rt.checkObserved(ctx, path, previous, true)
        const before = previous ? decodeText(previous) : ""
        const bytes = Buffer.from(args.content)
        await client.write(path, bytes)
        const final = await rt.afterWrite(ctx, client, path)
        const filediff = fileDiff(path, before, decodeText(final.bytes))
        return {
          title: args.filePath,
          output: [`Wrote ${args.filePath}`, final.diagnostics].filter(Boolean).join("\n\n"),
          metadata: { filediff, diff: filediff.patch, filepath: path, exists: exists.exit_code === 0 },
        }
      })
    },
  })
  const list = tool({
    description: "List directory contents through the Deltabox session.",
    args: { path: z.string().optional() },
    execute: (args, ctx) => {
      const rt = getRuntime()
      const path = rt.path(args.path ?? ".")
      return rt.tool(ctx, false, "list", async (client) => {
        const output = await client.exec(["ls", "-la", "--", path])
        if (output.exit_code !== 0) throw new Error(output.stderr || "Directory listing failed")
        return result(output)
      })
    },
  })
  return {
    lsp: tool({
      description: "Query language information from the current Deltabox mounted workspace.",
      args: {
        operation: z.enum(operations),
        filePath: z.string(),
        line: z.number().int().min(1),
        character: z.number().int().min(1),
        query: z.string().optional(),
      },
      execute: (args, ctx) => getRuntime().languageQuery(ctx, args),
    }),
    shell,
    // Older DevEco/OpenCode releases use bash instead of shell.
    bash: shell,
    read: tool({
      description:
        "Read a UTF-8 file or list a directory from the Deltabox view. offset is 1-based; limit defaults to 2000 lines.",
      args: {
        filePath: z.string(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      },
      execute: (args, ctx) => {
        const rt = getRuntime()
        const path = rt.path(args.filePath)
        return rt.tool(ctx, false, "read", async (client) => {
          const directory = await client.exec(["test", "-d", path])
          if (directory.exit_code === 0) {
            const output = await client.exec(["ls", "-1A", "--", path])
            if (output.exit_code !== 0) throw new Error(output.stderr || "Directory listing failed")
            return result(output)
          }
          const bytes = await client.read(path).catch(async (error) => {
            if ((await client.exec(["test", "-e", path])).exit_code === 1) await rt.observe(ctx, path)
            throw error
          })
          const text = decodeText(bytes)
          await rt.observe(ctx, path, bytes)
          const start = (args.offset ?? 1) - 1
          const lines = text.split("\n")
          const end = start + (args.limit ?? 2000)
          const view = lines
            .slice(start, end)
            .map((line, i) => `${start + i + 1}: ${line}`)
            .join("\n")
          return bounded(view + (end < lines.length ? `\n[More lines; read from offset ${end + 1}.]` : ""))
        })
      },
    }),
    write,
    // spec_write directly invokes the built-in writer; it must also be overridden.
    spec_write: write,
    edit: tool({
      description:
        "Replace exact text through Deltabox. oldString must match uniquely unless replaceAll is true. Use write for new files.",
      args: {
        filePath: z.string(),
        oldString: z.string().min(1),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      },
      execute: (args, ctx) => {
        const rt = getRuntime()
        const path = rt.path(args.filePath)
        if (!args.oldString) throw new Error("oldString must not be empty; use write for new files")
        return rt.tool(ctx, true, "edit", async (client) => {
          const previous = await client.read(path)
          await rt.checkObserved(ctx, path, previous)
          const old = decodeText(previous)
          const count = old.split(args.oldString).length - 1
          if (!count) throw new Error(`oldString not found in ${args.filePath}`)
          if (count > 1 && !args.replaceAll)
            throw new Error("oldString matches more than once; add context or use replaceAll")
          // Literal replacement: $&, $' and $$ must remain literal file content.
          const next = args.replaceAll
            ? old.split(args.oldString).join(args.newString)
            : old.replace(args.oldString, () => args.newString)
          await client.write(path, Buffer.from(next))
          const final = await rt.afterWrite(ctx, client, path)
          const filediff = fileDiff(path, old, decodeText(final.bytes))
          return {
            title: args.filePath,
            output: [`Edited ${args.filePath}`, final.diagnostics].filter(Boolean).join("\n\n"),
            metadata: { filediff, diff: filediff.patch, filepath: path },
          }
        })
      },
    }),
    apply_patch: tool({
      description:
        "Apply an *** Begin Patch patch through Deltabox. Supports add, exact-context update, delete and move. Include enough context to match uniquely.",
      args: { patchText: z.string() },
      execute: (args, ctx) => {
        const rt = getRuntime()
        return rt.tool(ctx, true, "apply_patch", (client) =>
          applyPatch(client, args.patchText, (p) => rt.path(p), {
            check: (p, bytes) => rt.checkObserved(ctx, p, bytes),
            record: (p, bytes) => rt.observe(ctx, p, bytes),
            afterWrite: (p) => rt.afterWrite(ctx, client, p),
          }),
        )
      },
    }),
    grep: tool({
      description: "Search the Deltabox view with DevEco's ripgrep. Errors are reported separately from no matches.",
      args: { pattern: z.string().min(1), path: z.string().optional(), include: z.string().optional() },
      execute: (args, ctx) => {
        const rt = getRuntime()
        const path = rt.path(args.path ?? ".")
        return rt.tool(ctx, false, "grep", async (client) =>
          result(
            await client.exec([
              "rg",
              "--line-number",
              "--no-heading",
              "--color",
              "never",
              ...(args.include ? ["--glob", args.include] : []),
              "--regexp",
              args.pattern,
              "--",
              path,
            ]),
            true,
          ),
        )
      },
    }),
    glob: tool({
      description: "Find files in the Deltabox view with a glob pattern using DevEco's ripgrep.",
      args: { pattern: z.string(), path: z.string().optional() },
      execute: (args, ctx) => {
        const rt = getRuntime()
        const path = rt.path(args.path ?? ".")
        return rt.tool(ctx, false, "glob", async (client) =>
          result(await client.exec(["rg", "--files", "--glob", args.pattern, "--", path]), true),
        )
      },
    }),
    find: tool({
      description: "Find paths by filename pattern inside the Deltabox project.",
      args: { path: z.string().optional(), pattern: z.string().optional() },
      execute: (args, ctx) => {
        const rt = getRuntime()
        const path = rt.path(args.path ?? ".")
        return rt.tool(ctx, false, "find", async (client) => {
          const output = await client.exec(["find", path, "-name", args.pattern ?? "*"])
          if (output.exit_code !== 0) throw new Error(output.stderr || "File search failed")
          return result(output)
        })
      },
    }),
    list,
    ls: list,
    sandbox_review: tool({
      description:
        "Inspect pending Deltabox file changes without changing them or opening an approval dialog. Users choose command or dialog confirmation with /sandbox-confirmation.",
      args: {},
      execute: (_args: {}, ctx: ToolContext) => getRuntime().command(ctx.sessionID, "sandbox-review", ""),
    }),
  }
}
