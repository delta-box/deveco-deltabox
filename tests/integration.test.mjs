import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlugin, COMMANDS } from "../dist/integration.js";
import { Runtime } from "../dist/runtime.js";
import { parseConfig } from "../dist/config.js";
import { FakeClient, context } from "./helpers.mjs";

function input() {
  const notices = [];
  return { directory: process.cwd(), worktree: process.cwd(), notices, experimental_capabilities: { sessionStopping: 1, commandResult: 1, shellEnv: 1 }, client: {
    tui: { showToast: async ({ body }) => { notices.push(body.message); } },
    session: { get: async ({ path }) => ({ data: { id: path.id, parentID: path.id === "child" ? "root" : undefined } }) },
  } };
}
function dependencies() {
  return { platform: "darwin", config: () => parseConfig({}), runtime: (p, c, host) => new Runtime(p, c, host, (dir) => new FakeClient(dir)) };
}

test("plugin entry exports one function and overrides current and legacy tool names", async () => {
  const entry = await import("../dist/plugin.js");
  assert.deepEqual(Object.keys(entry), ["default"]);
  const hooks = await createPlugin(input(), dependencies());
  for (const name of ["shell", "bash", "read", "write", "edit", "spec_write", "apply_patch", "glob", "grep", "find", "ls", "list"]) assert.ok(hooks.tool[name]);
  assert.equal(hooks.tool.sandbox_commit, undefined);
  assert.equal(hooks.tool.sandbox_abort, undefined);
  assert.equal(parseConfig({}).trusted, false);
});

test("stock hosts fail closed before opening any sandbox or executing a tool", async () => {
  const host = input();
  delete host.experimental_capabilities;
  const hooks = await createPlugin(host, dependencies());
  await assert.rejects(hooks["tool.execute.before"]({ tool: "write" }, { args: {} }), /patched DevEco Code host/);
  await assert.rejects(async () => hooks.tool.shell.execute({ command: "true" }, context()), /patched DevEco Code host/);
});

test("unsafe built-ins, MCP and unknown tools are blocked", async () => {
  const hooks = await createPlugin(input(), dependencies());
  for (const name of ["arkts_check", "switch_cwd", "plan_write", "verify_ui", "save_ui_screenshot", "custom_writer", "deveco_mcp_build", "batch"]) {
    await assert.rejects(hooks["tool.execute.before"]({ tool: name, sessionID: "root", callID: "a" }, { args: {} }), /no Deltabox adapter/);
  }
  for (const name of ["shell", "write", "spec_write", "task", "webfetch"]) await hooks["tool.execute.before"]({ tool: name, sessionID: "root", callID: "a" }, { args: {} });
});

test("invalid config and unsupported platforms leave guards active", async () => {
  const deps = dependencies();
  deps.config = () => { throw new Error("bad policy"); };
  const hooks = await createPlugin(input(), deps);
  await assert.rejects(hooks["tool.execute.before"]({ tool: "write" }, { args: {} }), /bad policy/);
  await assert.rejects(async () => hooks.tool.write.execute({ filePath: "a", content: "a" }, context()), /bad policy/);
  const unsupported = await createPlugin(input(), { ...dependencies(), platform: "win32" });
  await assert.rejects(unsupported["tool.execute.before"]({ tool: "shell" }, { args: {} }), /does not support win32/);
});

test("config preserves permissions and commands, disables host writers and enables human review", async () => {
  const hooks = await createPlugin(input(), dependencies());
  const config = { permission: { shell: "deny" }, agent: { build: { permission: "allow" }, unused: undefined }, command: { existing: { template: "hello" } }, lsp: {}, formatter: {}, snapshot: true };
  await hooks.config(config);
  assert.equal(config.permission.shell, "deny");
  assert.equal(config.permission.deltabox_review, "ask");
  assert.equal(config.agent.build.permission.deltabox_review, "ask");
  assert.equal(config.agent.build.permission["*"], "allow");
  assert.equal(config.command.existing.template, "hello");
  for (const name of Object.keys(COMMANDS)) assert.ok(config.command[name]);
  assert.equal(config.lsp, false);
  assert.equal(config.formatter, false);
  assert.equal(config.snapshot, false);
});

test("user slash commands execute in the hook and return a result without a model turn", async () => {
  const hooks = await createPlugin(input(), dependencies());
  await hooks.tool.write.execute({ filePath: "a", content: "hello" }, context());
  const output = { parts: [{ type: "text", text: "command" }] };
  await hooks["command.execute.before"]({ command: "sandbox-commit", sessionID: "root", arguments: "" }, output);
  assert.match(output.result.text, /Committed 1 change/);
  await hooks["command.execute.before"]({ command: "sandbox-review", sessionID: "root", arguments: "" }, output);
  assert.match(output.result.text, /No pending changes/);
  await hooks.dispose();
});

test("idle events are deduplicated and deleted sessions reject stale calls", async () => {
  const host = input();
  const hooks = await createPlugin(host, dependencies());
  await hooks.tool.write.execute({ filePath: "a", content: "hello" }, context());
  host.notices.length = 0;
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
  assert.equal(host.notices.length, 1);
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "root" } } } });
  await assert.rejects(hooks.tool.write.execute({ filePath: "a", content: "hello" }, context()), /closed/);
});
