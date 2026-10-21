import { relative } from "node:path";

export class FakeClient {
  files = new Map();
  head = new Map();
  scope;
  calls = [];
  project;
  started = 0;
  stopped = false;
  constructor(project, mode = "copy-private") { this.project = project; this.mode = mode; }
  async start() { this.started++; return this.status(); }
  async stop() { this.calls.push("stop"); this.stopped = true; }
  async status() { return {
    session_id: "sandbox", project: this.project, status: "running", pending_changes: (await this.review()).pending_changes,
    requested_fs_mode: this.mode, resolved_fs_mode: this.mode, host_visibility: this.mode === "cbcow-through" ? "immediate" : "on-commit",
    state_provider: null, fallback_reason: null, tainted: false, rollback_guarantee: "process-crash", durability: "fast",
  }; }
  async read(path) { this.calls.push(["read", path]); if (!this.files.has(path)) throw new Error(`Missing: ${path}`); return this.files.get(path); }
  async write(path, bytes) { this.calls.push(["write", path]); this.files.set(path, bytes); }
  async exec(argv, cwd, label) {
    this.calls.push(["exec", argv, cwd, label]);
    const result = { exit_code: 0, stdout: "", stderr: "", duration_ms: 1, truncated: false };
    if (argv[0] === "test" && argv[1] === "-d") result.exit_code = 1;
    if (argv[0] === "test" && argv[1] === "-e") result.exit_code = this.files.has(argv[2]) ? 0 : 1;
    if (argv[0] === "sh" && argv[3] === "deltabox-patch") result.exit_code = this.files.has(argv[4]) ? 1 : 0;
    if (argv[0] === "rm") this.files.delete(argv[2]);
    return result;
  }
  async begin(kind, label) {
    this.calls.push(["begin", kind]);
    this.scope ??= { checkpoint_id: "checkpoint", kind, label, files: new Map(this.files) };
    return this.scope;
  }
  async active() { return this.scope ?? null; }
  async review() {
    const base = this.scope?.files ?? this.head;
    const changes = [];
    for (const path of new Set([...base.keys(), ...this.files.keys()])) {
      const old = base.get(path);
      const next = this.files.get(path);
      if (old?.equals(next ?? Buffer.alloc(0)) && next) continue;
      changes.push({ path: relative(this.project, path), kind: !old ? "added" : !next ? "deleted" : "modified", old_size: old?.length ?? null, new_size: next?.length ?? null, is_binary: false, added_lines: 1, removed_lines: old ? 1 : 0, text_diff: "test diff" });
    }
    return { from: "base", to: "head", pending_changes: changes.length, changes };
  }
  async diff(from, to) { this.calls.push(["diff", from, to]); return this.review(); }
  async commit() { const applied = (await this.review()).pending_changes; this.calls.push("commit"); this.head = new Map(this.files); this.scope = undefined; return { applied, checkpoint_id: "accepted" }; }
  async abort() { const restored = (await this.review()).pending_changes; this.calls.push("abort"); this.files = new Map(this.scope?.files ?? this.head); this.scope = undefined; return { restored, checkpoint_id: "base" }; }
  async skip() { this.calls.push("skip"); return this.scope; }
}

export function context(sessionID = "root", ask = async () => {}) {
  return { sessionID, messageID: "message", agent: "build", directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata() {}, ask };
}

export function approve(gate, sessionID, reply = "once") {
  return async (request) => {
    gate.event({ type: "permission.asked", properties: { id: "permission-1", sessionID, ...request } });
    gate.event({ type: "permission.replied", properties: { requestID: "permission-1", sessionID, reply } });
    if (reply === "reject") throw new Error("User rejected permission");
  };
}
