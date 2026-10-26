// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
import { once } from "node:events"
import type {
  NativeDeltaboxInstance,
  NativeSessionInfo,
  NativeExecResult,
  NativeActiveReview,
  NativeDiffResult,
  NativeCommitResult,
  NativeAbortResult,
  DeltaboxNativeBinding,
} from "deltabox-lite"
import type { Config, ReviewMode } from "./config"
import { loadDeltabox } from "./native"
import { windowsArgv } from "./windows"

export type SessionInfo = NativeSessionInfo
export type Diff = NativeDiffResult
export interface Client {
  start(): Promise<SessionInfo>
  stop(): Promise<void>
  status(): Promise<SessionInfo>
  exec(argv: string[], cwd?: string, label?: string, env?: Record<string, string>): Promise<NativeExecResult>
  read(path: string): Promise<Buffer>
  write(path: string, bytes: Buffer): Promise<void>
  begin(kind: ReviewMode, label?: string): Promise<NativeActiveReview>
  active(): Promise<NativeActiveReview | null>
  review(): Promise<Diff>
  diff(from?: string, to?: string): Promise<Diff>
  commit(): Promise<NativeCommitResult>
  abort(): Promise<NativeAbortResult>
  skip(): Promise<NativeActiveReview>
}

const require = createRequire(import.meta.url)
const OUTPUT_LIMIT = 32 * 1024 * 1024

export class DeltaboxClient implements Client {
  private native?: NativeDeltaboxInstance
  private child?: ChildProcessWithoutNullStreams
  private failure?: Error
  private sequence = 0
  private pending = new Map<
    number,
    {
      resolve(value: any): void
      reject(error: Error): void
      timer: NodeJS.Timeout
    }
  >()
  private info?: SessionInfo
  private binary: string

  constructor(
    private project: string,
    private config: Config,
    private commands: { shell?: string; ripgrep?: () => Promise<string> } = {},
  ) {
    this.binary = config.bin === "deltabox" ? loadDeltabox().binaryPath() : config.bin
    if (config.transport === "native") {
      const pkg = loadDeltabox()
      const binding = config.nativeAddon ? (require(config.nativeAddon) as DeltaboxNativeBinding) : pkg.loadNative()
      // Published 0.1.2 uses an options object; this source branch still uses
      // positional trusted/state args. Isolation is on by default. Only an
      // explicit trusted:true in the user's config opts into ambient execution.
      if (typeof binding.NativeDeltabox.prototype.networkApprovalsVersion === "function") {
        this.native = new binding.NativeDeltabox(project, this.binary, {
          isolation: config.trusted ? "none" : "deltabox",
          stateDir: config.stateDir ?? undefined,
          runtimeDir: config.runtimeDir ?? undefined,
          ...(config.filesystem.mode === "auto" ? {} : { fsMode: config.filesystem.mode }),
        })
      } else {
        const Legacy = binding.NativeDeltabox as unknown as new (
          project: string,
          binary: string,
          trusted: boolean,
          stateDir?: string,
          runtimeDir?: string,
        ) => NativeDeltaboxInstance
        this.native = new Legacy(
          project,
          this.binary,
          config.trusted,
          config.stateDir ?? undefined,
          config.runtimeDir ?? undefined,
        )
      }
    }
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.config.stateDir ? { DELTABOX_STATE_DIR: this.config.stateDir } : {}),
      ...(this.config.runtimeDir ? { DELTABOX_RUNTIME_DIR: this.config.runtimeDir } : {}),
    }
  }

  private fail(error: Error): void {
    this.failure = error
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
    this.child?.kill()
  }

  private rpc<T>(method: string, params: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (!this.child) {
      const child = (this.child = spawn(this.binary, ["serve"], { cwd: this.project, env: this.env(), stdio: "pipe" }))
      let stderr = ""
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192)
      })
      const lines = createInterface({ input: child.stdout })
      lines.on("line", (line) => {
        try {
          if (Buffer.byteLength(line) > OUTPUT_LIMIT) throw new Error("Deltabox response exceeds output limit")
          const value = JSON.parse(line)
          const call = this.pending.get(value.id)
          if (!call) return
          clearTimeout(call.timer)
          this.pending.delete(value.id)
          if (value.error) call.reject(new Error(value.error.message))
          else call.resolve(value.result)
        } catch (error) {
          this.fail(error as Error)
        }
      })
      child.on("error", (error) => this.fail(error))
      child.stdin.on("error", (error) => this.fail(error))
      child.on("close", () => {
        lines.close()
        this.fail(new Error(`Deltabox server stopped. ${stderr}`))
      })
    }
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              "Deltabox request timed out; the session outcome is unknown. Restart the plugin before further operations.",
            ),
          ),
        this.config.timeoutMs,
      )
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    })
  }

  private cli(args: string[], input?: Buffer): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd: this.project, env: this.env(), stdio: "pipe" })
      const chunks: Buffer[] = []
      let size = 0
      let stderr = ""
      let error: Error | undefined
      const terminate = (reason: Error) => {
        error ??= reason
        this.failure = error
        child.kill("SIGKILL")
      }
      const timer = setTimeout(
        () => terminate(new Error("Deltabox command timed out; outcome is unknown")),
        this.config.timeoutMs,
      )
      child.stdout.on("data", (data: Buffer) => {
        size += data.length
        if (size > OUTPUT_LIMIT) terminate(new Error("Deltabox response exceeds output limit"))
        else chunks.push(data)
      })
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192)
      })
      child.on("error", (reason) => {
        error = reason
      })
      child.stdin.on("error", (reason) => {
        error ??= reason
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (error || code !== 0) reject(error ?? new Error(stderr || `Deltabox exited with ${code}`))
        else resolve(Buffer.concat(chunks))
      })
      child.stdin.end(input)
    })
  }

  private id(): string {
    if (!this.info) throw new Error("Deltabox session has not started")
    return this.info.session_id
  }

  private async operation<T>(method: string, args: string[], params: object = {}): Promise<T> {
    if (this.config.transport === "serve") return this.rpc(method, { session_id: this.id(), ...params })
    return JSON.parse((await this.cli([...args, this.id(), "--project", this.project])).toString())
  }

  async start(): Promise<SessionInfo> {
    if (this.info) return this.info
    const { filesystem: fs, policy } = this.config
    if (this.native) {
      this.info = await this.native.startSession(
        policy ?? undefined,
        fs.durability,
        fs.groupCommitMs ?? undefined,
        fs.mode,
        fs.require,
      )
    } else if (this.config.transport === "serve") {
      this.info = await this.rpc("session.start", {
        project: this.project,
        policy,
        fs_mode: fs.mode === "auto" ? null : fs.mode,
        require_fs_mode: fs.require,
        durability: fs.durability,
        group_commit_ms: fs.groupCommitMs,
      })
    } else {
      const args = ["session", "start", this.project, "--json"]
      if (policy) args.push("--policy", policy)
      if (fs.mode !== "auto") args.push("--fs-mode", fs.mode)
      if (fs.require) args.push("--require-fs-mode")
      if (fs.durability === "strict") args.push("--durable")
      if (fs.groupCommitMs !== null) args.push("--group-commit-ms", String(fs.groupCommitMs))
      this.info = JSON.parse((await this.cli(args)).toString())
    }
    return this.info!
  }

  async stop(): Promise<void> {
    if (!this.info) {
      await this.stopChild()
      return
    }
    // Do not discard identity on failure: callers must not mistake a failed stop for success.
    if (this.native) await this.native.stopSession(this.id())
    else await this.operation("session.stop", ["session", "stop"])
    this.info = undefined
    await this.stopChild()
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const closed = once(child, "close").catch(() => {})
    child.stdin.end()
    child.kill()
    await closed
  }

  status(): Promise<SessionInfo> {
    return this.native ? this.native.sessionStatus(this.id()) : this.operation("session.status", ["session", "status"])
  }
  async exec(
    argv: string[],
    cwd = this.project,
    label?: string,
    env?: Record<string, string>,
  ): Promise<NativeExecResult> {
    if (argv[0] === "rg") {
      if (!this.commands.ripgrep) throw new Error("DevEco ripgrep resolver is unavailable")
      argv = [await this.commands.ripgrep(), ...argv.slice(1)]
    }
    if (process.platform === "win32") argv = windowsArgv(argv, cwd, this.commands.shell)
    const entries = env ? Object.entries(env) : undefined
    if (entries?.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")))
      throw new Error("Invalid command environment")
    if (this.native)
      return this.native.exec(
        this.id(),
        argv,
        cwd,
        entries?.map(([key, value]) => ({ key, value })),
        label,
      )
    if (this.config.transport === "serve")
      return this.rpc("session.exec", { session_id: this.id(), argv, cwd, label, env: entries })
    const args = ["exec", this.id(), "--project", this.project, "--cwd", cwd]
    if (label) args.push("--label", label)
    for (const [key, value] of entries ?? []) args.push("--env", `${key}=${value}`)
    return JSON.parse((await this.cli([...args, "--", ...argv])).toString())
  }
  async read(path: string): Promise<Buffer> {
    if (this.native) return this.native.readFile(this.id(), path)
    if (this.config.transport === "serve") {
      const result = await this.rpc<{ content_base64: string }>("fs.read", { session_id: this.id(), path })
      return Buffer.from(result.content_base64, "base64")
    }
    return this.cli(["read", this.id(), "--project", this.project, path])
  }
  async write(path: string, bytes: Buffer): Promise<void> {
    if (this.native) return this.native.writeFile(this.id(), path, bytes)
    if (this.config.transport === "serve") {
      await this.rpc("fs.write", { session_id: this.id(), path, content_base64: bytes.toString("base64") })
    } else await this.cli(["write", this.id(), "--project", this.project, path, "--stdin"], bytes)
  }
  begin(kind: ReviewMode, label?: string): Promise<NativeActiveReview> {
    if (this.native) return this.native.beginReview(this.id(), kind, label)
    return this.operation("review.begin", ["review", "begin", "--kind", kind, ...(label ? ["--label", label] : [])], {
      kind,
      label,
    })
  }
  active(): Promise<NativeActiveReview | null> {
    return this.native ? this.native.reviewStatus(this.id()) : this.operation("review.status", ["review", "status"])
  }
  review(): Promise<Diff> {
    return this.native ? this.native.reviewDiff(this.id()) : this.operation("review.diff", ["review", "diff", "--json"])
  }
  diff(from?: string, to?: string): Promise<Diff> {
    if (this.native) return this.native.diff(this.id(), from, to)
    return this.operation(
      "diff.list",
      ["diff", "--json", ...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])],
      { from, to },
    )
  }
  commit(): Promise<NativeCommitResult> {
    return this.native ? this.native.reviewCommit(this.id()) : this.operation("review.commit", ["review", "commit"])
  }
  abort(): Promise<NativeAbortResult> {
    return this.native ? this.native.reviewAbort(this.id()) : this.operation("review.abort", ["review", "abort"])
  }
  skip(): Promise<NativeActiveReview> {
    return this.native ? this.native.reviewSkip(this.id()) : this.operation("review.skip", ["review", "skip"])
  }
}
