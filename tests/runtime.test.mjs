import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../dist/runtime.js";
import { loadConfig, parseConfig } from "../dist/config.js";
import { FakeClient, context, approve } from "./helpers.mjs";

function setup(t, raw = {}, parent = async () => undefined) {
  const project = mkdtempSync(join(tmpdir(), "deveco-unit-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const clients = [];
  const notes = [];
  const rt = new Runtime(project, parseConfig(raw), { parent, notify: async (m) => { notes.push(m); } }, (p, cfg) => { const c = new FakeClient(p, cfg.filesystem.mode === "auto" ? "copy-private" : cfg.filesystem.mode); clients.push(c); return c; });
  return { rt, clients, notes, project };
}

test("config merges nested project settings and resolves paths; invalid config fails closed", (t) => {
  const { project } = setup(t);
  const user = join(project, "user.json");
  writeFileSync(user, JSON.stringify({ trusted: false, filesystem: { mode: "cbcow-private", require: true }, review: { mode: "tool" } }));
  writeFileSync(join(project, "deltabox.json"), JSON.stringify({ filesystem: { durability: "strict" }, policy: "policy.toml" }));
  const cfg = loadConfig(project, user);
  assert.equal(cfg.trusted, false);
  assert.equal(cfg.filesystem.mode, "cbcow-private");
  assert.equal(cfg.filesystem.require, true);
  assert.equal(cfg.review.mode, "tool");
  assert.equal(cfg.policy, join(project, "policy.toml"));
  writeFileSync(join(project, "deltabox.json"), '{"filesystem":{"mode":"typo"}}');
  assert.throws(() => loadConfig(project, user));
});

test("state paths resolve existing symlink ancestors before creating private views", (t) => {
  const { project, rt } = setup(t);
  symlinkSync(project, join(project, "alias"));
  writeFileSync(join(project, "deltabox.json"), JSON.stringify({ stateDir: "alias/new/state", runtimeDir: "alias/new/runtime" }));
  const cfg = loadConfig(project, join(project, "missing-user.json"));
  assert.equal(cfg.stateDir, join(rt.project, "new/state"));
  assert.equal(cfg.runtimeDir, join(rt.project, "new/runtime"));
});

test("task review starts before first mutation; skip and mode changes preserve earliest rollback", async (t) => {
  const { rt, clients } = setup(t);
  const ctx = context();
  await rt.tool(ctx, true, "write", (c) => c.write(rt.path("a"), Buffer.from("a")).then(() => "written"));
  await rt.command("root", "sandbox-skip", "");
  await rt.tool(ctx, true, "write", (c) => c.write(rt.path("b"), Buffer.from("b")).then(() => "written"));
  await rt.command("root", "sandbox-mode", "risky");
  assert.equal(clients[0].scope.kind, "task");
  assert.equal((await clients[0].review()).pending_changes, 2);
  await rt.command("root", "sandbox-abort", "");
  assert.equal(clients[0].files.size, 0);
  assert.deepEqual(clients[0].calls[0], ["begin", "task"]);
});

test("parent and child sessions share a serialized resident coordinator", async (t) => {
  const { rt, clients } = setup(t, {}, async (id) => id === "child" ? "root" : undefined);
  let active = 0;
  let max = 0;
  const act = async (c) => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 10));
    await c.write(rt.path(`file-${c.calls.length}`), Buffer.from("a"));
    active--;
    return "done";
  };
  await Promise.all([rt.tool(context(), true, "write", act), rt.tool(context("child"), true, "write", act)]);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].started, 1);
  assert.equal(max, 1);
  await rt.close("child");
  assert.equal(clients[0].stopped, false);
  await rt.command("root", "sandbox-commit", "");
  await rt.dispose();
  assert.equal(clients[0].stopped, true);
});

test("different conversations never share review decisions", async (t) => {
  const { rt, clients } = setup(t);
  for (const id of ["one", "two"]) await rt.tool(context(id), true, "write", async (c) => { await c.write(rt.path(id), Buffer.from(id)); return id; });
  await rt.command("one", "sandbox-commit", "");
  assert.equal(clients.length, 2);
  assert.equal(await clients[0].active(), null);
  assert.ok(await clients[1].active());
});

test("clean idle sessions are reused without carrying review modes or ownership", async (t) => {
  const { rt, clients } = setup(t, { filesystem: { mode: "cbcow-through" } });
  await rt.command("one", "sandbox-mode", "tool");
  await rt.idle("one");
  await rt.tool(context("two"), false, "read", async () => "read");
  assert.equal(clients.length, 1);
  assert.equal(clients[0].started, 1);
  assert.match(await rt.command("two", "sandbox-status", ""), /Review: task/);
  await rt.close("one");
  assert.equal(clients[0].stopped, false);
  await rt.idle("two");
  await Promise.all([rt.dispose(), rt.dispose()]);
  assert.equal(clients[0].calls.filter((call) => call === "stop").length, 1);
});

test("idle handoff cannot race admitted follow-up work or transfer skipped reviews", async (t) => {
  const { rt, clients } = setup(t, { filesystem: { mode: "cbcow-through" } });
  await rt.tool(context(), false, "read", async () => "read");
  const client = clients[0];
  const original = client.active.bind(client);
  let release;
  let entered;
  const held = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  client.active = async () => { entered(); await held; return original(); };
  const parking = rt.idle("root");
  await started;
  const followup = rt.tool(context(), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([parking, followup]);
  client.active = original;
  await rt.command("root", "sandbox-skip", "");
  await rt.idle("root");
  await rt.tool(context("two"), false, "read", async () => "read");
  assert.equal(clients.length, 2);
  assert.ok(await client.active());
  await rt.dispose();
});

test("clean private snapshots are released before a new conversation acquires the project", async (t) => {
  const { rt, clients } = setup(t);
  await rt.tool(context(), false, "read", async () => "read");
  let release;
  let entered;
  const held = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  const stop = clients[0].stop.bind(clients[0]);
  clients[0].stop = async () => { entered(); await held; await stop(); };
  const idle = rt.idle("root");
  await started;
  const next = rt.tool(context("two"), false, "read", async () => "read");
  await new Promise((r) => setImmediate(r));
  assert.equal(clients.length, 1);
  release();
  await Promise.all([idle, next]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].stopped, true);
  assert.equal(clients[1].started, 1);
  await rt.dispose();
});

for (const [reply, expected] of [["once", "commit"], ["always", "commit"], ["reject", "abort"]]) {
  test(`tool review uses an explicit ${reply} reply`, async (t) => {
    const { rt, clients } = setup(t, { review: { mode: "tool" } });
    const ctx = context("root", approve(rt.gate, "root", reply));
    await rt.tool(ctx, true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
    assert.ok(clients[0].calls.includes(expected));
    assert.equal(await clients[0].active(), null);
    assert.equal(clients[0].files.size, expected === "commit" ? 1 : 0);
  });
}

test("automatic permission allow commits under the host policy; reads do not open reviews", async (t) => {
  const { rt, clients } = setup(t, { review: { mode: "risky" } });
  await rt.tool(context(), false, "glob", async () => "no files");
  assert.equal(await clients[0].active(), null);
  const output = await rt.tool(context(), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
  assert.equal(output, "written");
  assert.equal(await clients[0].active(), null);
  assert.equal(clients[0].calls.includes("commit"), true);
});

for (const mode of ["task", "tool", "risky"]) {
  test(`${mode} reviews only at its configured boundary and skips read-only or empty changes`, async (t) => {
    const { rt, clients } = setup(t, { review: { mode } });
    const requests = [];
    const ctx = context("root", async (request) => { requests.push(request); });
    await rt.tool(ctx, false, "read", async () => "read");
    await rt.stopping(ctx);
    assert.equal(requests.length, 0);
    await rt.tool(ctx, true, "shell", async () => "no file changes");
    await rt.stopping(ctx);
    assert.equal(requests.length, 0);
    for (const file of ["first", "second"]) {
      await rt.tool(ctx, true, "write", async (c) => { await c.write(rt.path(file), Buffer.from(file)); return "written"; });
    }
    assert.equal(requests.length, mode === "task" ? 0 : 2);
    await rt.stopping(ctx);
    assert.equal(requests.length, mode === "task" ? 1 : 2);
    assert.equal(requests[0].metadata.reviewMode, mode);
    assert.equal(requests[0].metadata.pendingChanges, mode === "task" ? 2 : 1);
    assert.equal(requests[0].metadata.changes.length, mode === "task" ? 2 : 1);
    assert.equal(await clients[0].active(), null);
    assert.equal(clients[0].files.size, 2);
  });
}

test("root stopping waits for approval and child stopping cannot commit the shared scope", async (t) => {
  const { rt, clients } = setup(t, {}, async (id) => id === "child" ? "root" : undefined);
  await rt.tool(context("child"), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
  await rt.stopping(context("child"));
  assert.ok(await clients[0].active());
  let enter, release;
  const entered = new Promise((r) => { enter = r; });
  const held = new Promise((r) => { release = r; });
  let stopped = false;
  const stopping = rt.stopping(context("root", async () => { enter(); await held; })).then(() => { stopped = true; });
  await entered;
  assert.equal(stopped, false);
  assert.ok(await clients[0].active());
  release();
  await stopping;
  assert.equal(await clients[0].active(), null);
});

test("cancelling stopping preserves changes; rejecting a later review rolls them back", async (t) => {
  const { rt, clients } = setup(t);
  await rt.tool(context(), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
  const controller = new AbortController();
  await rt.stopping({ ...context("root", async () => { controller.abort(); throw new Error("cancelled"); }), abort: controller.signal });
  assert.ok(await clients[0].active());
  await rt.stopping(context("root", approve(rt.gate, "root", "reject")));
  assert.equal(clients[0].files.size, 0);
});

test("review transport errors preserve pending work, and ambiguous commit never triggers abort", async (t) => {
  const { rt, clients } = setup(t, { review: { mode: "tool" } });
  await assert.rejects(rt.tool(context("root", async () => { throw new Error("UI unavailable"); }), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; }), /UI unavailable/);
  assert.ok(await clients[0].active());
  clients[0].commit = async () => { throw new Error("commit outcome unknown"); };
  await assert.rejects(rt.review(context("root", approve(rt.gate, "root"))), /commit outcome unknown/);
  assert.equal(clients[0].calls.includes("abort"), false);
});

test("cancellation retains the queue until running work settles and leaves changes pending", async (t) => {
  const { rt, clients } = setup(t, { review: { mode: "tool" } });
  const controller = new AbortController();
  const ctx = { ...context(), abort: controller.signal };
  let release;
  const wait = new Promise((r) => { release = r; });
  let started;
  const admitted = new Promise((r) => { started = r; });
  const running = rt.tool(ctx, true, "shell", async (c) => { started(); await wait; await c.write(rt.path("a"), Buffer.from("a")); return "done"; });
  await admitted;
  controller.abort();
  let second = false;
  const next = rt.tool(context(), false, "read", async () => { second = true; return "read"; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(second, false);
  release();
  await assert.rejects(running, /abort/i);
  await next;
  assert.ok(await clients[0].active());
});

test("idle reviews notify once requested without starting unused sessions; disposal aborts pending work", async (t) => {
  const { rt, clients, notes } = setup(t);
  await rt.idle("unused");
  assert.equal(clients.length, 0);
  await rt.tool(context(), true, "write", async (c) => { await c.write(rt.path("a"), Buffer.from("a")); return "written"; });
  await rt.idle("root");
  assert.match(notes.at(-1), /sandbox-review/);
  await rt.dispose();
  assert.deepEqual(clients[0].calls.slice(-2), ["abort", "stop"]);
  await assert.rejects(rt.tool(context(), false, "read", async () => ""), /closed/);
});

test("project paths reject traversal and sibling-prefix escapes", (t) => {
  const { rt, project } = setup(t);
  assert.equal(rt.path("a/../b"), join(rt.project, "b"));
  assert.throws(() => rt.path("../outside"), /outside/);
  assert.throws(() => rt.path(project + "-sibling/file"), /outside/);
  assert.throws(() => rt.path("a\0b"), /path/);
});
