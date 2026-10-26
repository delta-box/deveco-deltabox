// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import { realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { DeltaboxClient, type Client } from "./client"
import type { Config, ReviewMode } from "./config"
import { ReviewGate, pendingReview, renderDiff, summary } from "./review"
import type { MountedLanguage, LanguageRequest, LanguageView } from "./language"

type Confirmation = "command" | "dialog"

type Entry = {
  client: Client
  ready: boolean
  reusable: boolean
  tail: Promise<unknown>
  mode: ReviewMode
  confirmation: Confirmation
  closed: boolean
  revision: number
  closing?: Promise<void>
}
export interface RuntimeHost {
  shell?: string
  ripgrep?: () => Promise<string>
  parent(sessionID: string): Promise<string | undefined>
  notify(message: string, warning?: boolean): Promise<void>
}

export class Runtime {
  readonly project: string
  readonly gate = new ReviewGate()
  private roots = new Map<string, Promise<string>>()
  private sessions = new Map<string, Entry>()
  private modes = new Map<string, ReviewMode>()
  private confirmations = new Map<string, Confirmation>()
  private observed = new Map<string, Map<string, string | undefined>>()
  private warm?: Client
  private retiring = new Set<Promise<void>>()
  private deleted = new Set<string>()
  private disposed = false
  private disposal?: Promise<void>
  private languageViews = new Map<Client, LanguageView>()

  constructor(
    readonly directory: string,
    readonly config: Config,
    private host: RuntimeHost,
    private createClient: (project: string, config: Config) => Client = (p, c) => new DeltaboxClient(p, c, host),
    private language?: MountedLanguage,
  ) {
    this.project = realpathSync(directory)
  }

  path(value: string): string {
    if (!value || value.includes("\0")) throw new Error("A non-empty project path is required")
    const absolute = resolve(this.directory, value)
    let suffix = relative(this.directory, absolute)
    if (isAbsolute(value) && this.inside(relative(this.project, absolute))) suffix = relative(this.project, absolute)
    if (!this.inside(suffix)) throw new Error(`Path is outside the Deltabox project: ${value}`)
    return resolve(this.project, suffix)
  }

  private async languageView(client: Client): Promise<LanguageView> {
    const existing = this.languageViews.get(client)
    if (existing) return existing
    const info = await client.status()
    if (!info.mountpoint || !isAbsolute(info.mountpoint))
      throw new Error("Deltabox language services require a host-accessible session mountpoint.")
    const view = { project: this.project, mountpoint: info.mountpoint }
    this.languageViews.set(client, view)
    return view
  }

  private async disposeLanguage(client: Client): Promise<void> {
    const view = this.languageViews.get(client)
    if (!view) return
    await this.language?.dispose(view)
    this.languageViews.delete(client)
  }

  private async stopClient(client: Client): Promise<void> {
    await this.disposeLanguage(client)
    await client.stop()
  }

  async languageQuery(ctx: ToolContext, args: LanguageRequest) {
    // Language-server startup can create workspace caches as well as read files.
    return this.tool(ctx, true, "lsp", async (client) => {
      if (!this.language) throw new Error("Deltabox language services have not been initialized.")
      return this.language.query(await this.languageView(client), { ...args, filePath: this.path(args.filePath) })
    })
  }

  async afterWrite(ctx: ToolContext, client: Client, path: string) {
    const previous = await client.read(path)
    const diagnostics = this.language?.enabled
      ? await this.language.afterWrite(await this.languageView(client), path).finally(async () => {
          // Also register formatted bytes if diagnostics fail after formatting.
          const bytes = await client.read(path)
          if (!bytes.equals(previous)) await client.write(path, bytes)
          await this.observe(ctx, path, bytes)
        })
      : ""
    const bytes = await client.read(path)
    await this.observe(ctx, path, bytes)
    return { bytes, diagnostics }
  }

  private inside(suffix: string): boolean {
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  }

  /** Observation belongs to the conversation, including across clean private
   * snapshot refreshes. A shell or host edit must not silently invalidate it. */
  async observe(ctx: ToolContext, path: string, bytes?: Buffer): Promise<void> {
    const root = await this.root(ctx.sessionID)
    let files = this.observed.get(root)
    if (!files) {
      files = new Map()
      this.observed.set(root, files)
    }
    files.set(path, bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex"))
  }

  async checkObserved(ctx: ToolContext, path: string, bytes?: Buffer, requireRead = false): Promise<void> {
    const files = this.observed.get(await this.root(ctx.sessionID))
    if (!files?.has(path)) {
      if (requireRead && bytes !== undefined) throw new Error(`Read ${path} before overwriting an existing file.`)
      return
    }
    const current = bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex")
    if (files.get(path) !== current)
      throw new Error(`File changed since it was read or written: ${path}. Read it again before modifying it.`)
  }

  private root(id: string, ancestors = new Set<string>()): Promise<string> {
    if (ancestors.has(id)) return Promise.reject(new Error("Cyclic DevEco session ancestry"))
    if (this.disposed || this.deleted.has(id)) return Promise.reject(new Error("Deltabox session is closed"))
    let promise = this.roots.get(id)
    if (!promise) {
      const visited = new Set(ancestors).add(id)
      promise = this.host.parent(id).then((parent) => (parent ? this.root(parent, visited) : id))
      this.roots.set(id, promise)
      void promise.catch(() => this.roots.delete(id))
    }
    return promise
  }

  private queue<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(action)
    entry.tail = result.catch(() => {})
    return result
  }

  private async run<T>(id: string, action: (entry: Entry) => Promise<T>): Promise<T> {
    const root = await this.root(id)
    // A private session must release its project lease before a replacement starts.
    if (this.retiring.size) await Promise.all(this.retiring)
    if (this.disposed || this.deleted.has(id) || this.deleted.has(root)) throw new Error("Deltabox session is closed")
    let entry = this.sessions.get(root)
    if (!entry) {
      const warm = this.warm
      entry = {
        client: warm ?? this.createClient(this.project, this.config),
        ready: Boolean(warm),
        reusable: Boolean(warm),
        tail: Promise.resolve(),
        mode: this.modes.get(root) ?? this.config.review.mode,
        confirmation: this.confirmations.get(root) ?? "command",
        closed: false,
        revision: 0,
      }
      this.warm = undefined
      this.sessions.set(root, entry)
    }
    const current = entry
    current.revision++
    return this.queue(current, async () => {
      if (current.closed || this.deleted.has(id) || this.deleted.has(root))
        throw new Error("Deltabox session is closed")
      if (!current.ready) {
        const info = await current.client.start()
        current.ready = true
        current.reusable = info.resolved_fs_mode === "cbcow-through"
        const note = [
          `Deltabox: ${info.resolved_fs_mode}; visibility: ${info.host_visibility}; rollback: ${info.rollback_guarantee}.`,
          info.fallback_reason ? `Fallback: ${info.fallback_reason}` : "",
          info.tainted ? "Session is tainted; rollback may be unsafe." : "",
        ]
          .filter(Boolean)
          .join("\n")
        await this.host.notify(note, Boolean(info.fallback_reason || info.tainted))
      }
      return action(current)
    })
  }

  async tool<T extends ToolResult>(
    ctx: ToolContext,
    mutates: boolean,
    name: string,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    return this.run(ctx.sessionID, async (entry) => {
      ctx.abort.throwIfAborted()
      if (mutates && ["write", "edit", "apply_patch"].includes(name) && this.language?.enabled)
        await this.languageView(entry.client)
      if (mutates) await entry.client.begin(entry.mode, name)
      let result: T | undefined
      let error: unknown
      try {
        result = await action(entry.client)
      } catch (cause) {
        error = cause
      }
      // Keep the queue until native work actually settles, even if the UI has cancelled.
      if (mutates && entry.mode !== "task" && !ctx.abort.aborted) {
        try {
          await this.disposeLanguage(entry.client)
          await this.host.notify(
            entry.confirmation === "dialog"
              ? await this.gate.review(entry.client, ctx, entry.mode)
              : await pendingReview(entry.client),
          )
        } catch (cause) {
          error = error ? new AggregateError([error, cause], "Tool and review failed") : cause
        }
      }
      if (error) throw error
      ctx.abort.throwIfAborted()
      return result!
    })
  }

  /** Only dialog confirmation waits at the root turn boundary. */
  async stopping(ctx: ToolContext): Promise<void> {
    const root = await this.roots.get(ctx.sessionID)
    if (!root || root !== ctx.sessionID || this.disposed) return
    const entry = this.sessions.get(root)
    if (!entry || entry.closed) return
    await this.queue(entry, async () => {
      if (!entry.ready || entry.closed || entry.confirmation !== "dialog") return
      await this.disposeLanguage(entry.client)
      const result = await this.gate.review(entry.client, ctx, entry.mode)
      if (result !== "No active review." && result !== "No pending changes.") await this.host.notify(result)
    })
  }

  /** User slash-command operations. Model inspection only uses sandbox-review. */
  async command(id: string, command: string, args: string): Promise<string> {
    const parts = args.trim().split(/\s+/).filter(Boolean)
    // A UI preference must not acquire a filesystem lease or wait for a review.
    if (command === "sandbox-confirmation") {
      const root = await this.root(id)
      if (!parts.length) return `Confirmation: ${this.confirmations.get(root) ?? "command"}.`
      if (parts.length !== 1 || (parts[0] !== "command" && parts[0] !== "dialog"))
        throw new Error("Usage: /sandbox-confirmation [command|dialog]")
      this.confirmations.set(root, parts[0])
      const entry = this.sessions.get(root)
      if (entry) entry.confirmation = parts[0]
      return `Confirmation: ${parts[0]}. Applies at the next review boundary; existing changes and open dialogs are unchanged.`
    }
    return this.run(id, async (entry) => {
      const client = entry.client
      if (command === "sandbox-mode") {
        if (parts.length !== 1 || !["task", "tool", "risky"].includes(parts[0]))
          throw new Error("Usage: /sandbox-mode task|tool|risky")
        entry.mode = parts[0] as ReviewMode
        this.modes.set(await this.root(id), entry.mode)
        return `Review mode: ${entry.mode}. Existing pending changes keep their original rollback point.`
      }
      if (command === "sandbox-diff") {
        if (parts.length > 2) throw new Error("Usage: /sandbox-diff [from] [to]")
        return renderDiff(await client.diff(parts[0], parts[1]))
      }
      if (parts.length) throw new Error(`/${command} takes no arguments`)
      if (command === "sandbox-status") {
        const info = await client.status()
        return [
          `Session: ${info.session_id} (${info.status})`,
          `Project: ${info.project}`,
          `Review: ${entry.mode}; pending changes: ${info.pending_changes}`,
          `Confirmation: ${entry.confirmation}`,
          `Filesystem: ${info.requested_fs_mode} -> ${info.resolved_fs_mode}; provider: ${info.state_provider ?? "copy-private"}`,
          `Visibility: ${info.host_visibility}; durability: ${info.durability}; rollback: ${info.rollback_guarantee}`,
          `Tainted: ${info.tainted}; fallback: ${info.fallback_reason ?? "none"}`,
          `Transport: ${this.config.transport}; trusted commands: ${this.config.transport === "native" && this.config.trusted}`,
        ].join("\n")
      }
      if (command === "sandbox-review") return renderDiff(await client.review())
      if (command === "sandbox-commit" || command === "sandbox-abort") await this.disposeLanguage(client)
      if (!(await client.active())) return "No active review."
      if (command === "sandbox-commit") return `Committed ${(await client.commit()).applied} change(s).`
      if (command === "sandbox-abort") return `Aborted ${(await client.abort()).restored} change(s).`
      if (command === "sandbox-skip") {
        await client.skip()
        return "Kept changes pending and preserved the original rollback point."
      }
      throw new Error(`Unknown sandbox command: ${command}`)
    })
  }

  async idle(id: string): Promise<void> {
    // Do not create a backend session for turns which did not use project tools.
    const root = await this.roots.get(id)
    if (!root || root !== id || this.disposed) return
    const entry = this.sessions.get(root)
    if (!entry || entry.closed) return
    const revision = entry.revision
    await this.queue(entry, async () => {
      if (!entry.ready || entry.closed || entry.revision !== revision) return
      if (await entry.client.active()) {
        const diff = await entry.client.review()
        if (diff.pending_changes) {
          await this.host.notify(
            `${diff.pending_changes} pending change(s):\n${summary(diff)}\nUse /sandbox-review, /sandbox-commit, /sandbox-abort or /sandbox-skip.`,
          )
          return
        }
        await this.disposeLanguage(entry.client)
        await entry.client.commit()
      }
      // Transfer only clean resources. A follow-up admitted during an await keeps
      // ownership; pending/skipped reviews always stay with their conversation.
      if (this.disposed || entry.closed || entry.revision !== revision) return
      if (entry.reusable && this.warm) return
      await this.disposeLanguage(entry.client)
      entry.closed = true
      this.sessions.delete(root)
      if (entry.reusable) {
        this.warm = entry.client
      } else {
        // Private snapshots can become stale while idle. Start the next turn
        // from the current host tree, after releasing this clean session.
        const stopping = this.stopClient(entry.client)
        this.retiring.add(stopping)
        await stopping
        this.retiring.delete(stopping)
      }
    })
  }

  async close(id: string): Promise<void> {
    this.deleted.add(id)
    const root = await this.roots.get(id)
    if (!root || root !== id) return
    this.observed.delete(root)
    const entry = this.sessions.get(root)
    if (!entry) return
    if (entry.closing) return entry.closing
    entry.closed = true
    entry.closing = this.queue(entry, async () => {
      await this.disposeLanguage(entry.client)
      if (entry.ready && (await entry.client.active())) await entry.client.abort()
      await this.stopClient(entry.client)
      this.sessions.delete(root)
    })
    return entry.closing
  }

  dispose(): Promise<void> {
    this.disposed = true
    return (this.disposal ??= this.cleanup())
  }

  private async cleanup(): Promise<void> {
    const warm = this.warm
    const results = await Promise.allSettled([
      ...[...this.sessions.keys()].map((id) => this.close(id)),
      ...this.retiring,
      ...(warm
        ? [
            this.stopClient(warm).then(() => {
              this.warm = undefined
            }),
          ]
        : []),
    ])
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)
    if (errors.length) throw new AggregateError(errors, "Deltabox cleanup failed; sessions remain recoverable")
  }
}
