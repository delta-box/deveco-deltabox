import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Runtime } from "../dist/runtime.js";
import { parseConfig } from "../dist/config.js";
import { makeTools } from "../dist/tools.js";
import { parsePatch, applyHunks } from "../dist/patch.js";
import { FakeClient, context, approve } from "./helpers.mjs";

function setup() {
  const project = process.cwd();
  const client = new FakeClient(project);
  const rt = new Runtime(project, parseConfig({}), { parent: async () => undefined, notify: async () => {} }, () => client);
  return { client, rt, tools: makeTools(() => rt), path: (p) => join(project, p) };
}

test("sandbox_review inspects task changes without requesting early approval", async () => {
  const { client, rt, tools, path } = setup();
  const ctx = context("root", async () => assert.fail("inspection must not request approval"));
  await tools.write.execute({ filePath: "pending.txt", content: "pending\n" }, ctx);
  const scope = await client.active();
  const output = await tools.sandbox_review.execute({}, ctx);
  assert.match(output, /pending.txt/);
  assert.equal(await client.active(), scope);
  assert.equal(client.calls.includes("commit"), false);
  assert.equal(client.calls.includes("abort"), false);
  assert.equal(client.files.get(path("pending.txt")).toString(), "pending\n");
  await rt.stopping(context("root", approve(rt.gate, "root")));
  assert.equal(client.calls.includes("commit"), true);
});

test("edit is literal, rejects ambiguous text and handles replaceAll", async () => {
  const { client, tools, path } = setup();
  client.files.set(path("a"), Buffer.from("foo foo"));
  await assert.rejects(tools.edit.execute({ filePath: "a", oldString: "foo", newString: "bar" }, context()), /more than once/);
  const edit = await tools.edit.execute({ filePath: "a", oldString: "foo", newString: "$& $$", replaceAll: true }, context());
  assert.equal(edit.metadata.filediff.before, "foo foo");
  assert.equal(edit.metadata.filediff.after, "$& $$ $& $$");
  assert.match(edit.metadata.diff, /-foo foo/);
  assert.equal(edit.output, "Edited a");
  assert.equal(client.files.get(path("a")).toString(), "$& $$ $& $$");
  assert.throws(() => tools.edit.execute({ filePath: "a", oldString: "", newString: "a" }, context()), /empty/);
});

test("shell forwards host toolchain environment without shell interpolation", async () => {
  const { client, tools } = setup();
  let received;
  client.exec = async (_argv, _cwd, _label, env) => { received = env; return { exit_code: 0, stdout: "1.3.9", stderr: "" }; };
  const ctx = { ...context(), shellEnv: async () => ({ PATH: "/path with spaces/bin", SAFE: "$(literal);`literal`" }) };
  const output = await tools.shell.execute({ command: "devecocli --version" }, ctx);
  assert.deepEqual(received, { PATH: "/path with spaces/bin", SAFE: "$(literal);`literal`" });
  assert.equal(output.output, "1.3.9");
  assert.equal(output.metadata.exit, 0);
});

test("read is line-bounded and fails on binary and invalid UTF-8", async () => {
  const { client, tools, path } = setup();
  client.files.set(path("a"), Buffer.from("a\nb\nc\n"));
  assert.match(await tools.read.execute({ filePath: "a", offset: 2, limit: 1 }, context()), /^2: b\n/);
  client.files.set(path("a"), Buffer.from([0]));
  await assert.rejects(tools.read.execute({ filePath: "a" }, context()), /Binary/);
  client.files.set(path("a"), Buffer.from([255]));
  await assert.rejects(tools.read.execute({ filePath: "a" }, context()));
});

test("shell and search use argv boundaries and report missing executables", async () => {
  const { client, tools, path } = setup();
  const command = "devecocli build --modules 'entry;literal'";
  await tools.shell.execute({ command, workdir: "subdir" }, context());
  const call = client.calls.find((c) => c[0] === "exec");
  assert.deepEqual(call[1], ["bash", "-c", command]);
  assert.equal(call[2], path("subdir"));
  await assert.rejects(async () => tools.shell.execute({ command: "sleep 10", timeout: 1 }, context()), /600000/);
  client.calls = [];
  await tools.grep.execute({ pattern: "--evil;$(id)", include: "*.ets" }, context());
  assert.deepEqual(client.calls[0][1], ["rg", "--line-number", "--no-heading", "--color", "never", "--glob", "*.ets", "--regexp", "--evil;$(id)", "--", process.cwd()]);
  client.exec = async () => ({ exit_code: 127, stderr: "rg: not found", stdout: "" });
  await assert.rejects(tools.glob.execute({ pattern: "*" }, context()), /not found/);
});

test("patch add/update/move/delete all use the reviewable view", async () => {
  const { client, tools, path, rt } = setup();
  client.files.set(path("a"), Buffer.from("one\ntwo\n"));
  client.files.set(path("delete"), Buffer.from("gone\n"));
  const patchText = "*** Begin Patch\n*** Add File: new\n+hello\n*** Update File: a\n*** Move to: moved\n@@\n one\n-two\n+three\n*** Delete File: delete\n*** End Patch";
  await tools.apply_patch.execute({ patchText }, context());
  assert.equal(client.files.get(path("new")).toString(), "hello\n");
  assert.equal(client.files.get(path("moved")).toString(), "one\nthree\n");
  assert.equal(client.files.has(path("a")), false);
  assert.equal(client.files.has(path("delete")), false);
  await rt.command("root", "sandbox-abort", "");
  assert.equal(client.files.get(path("a")).toString(), "one\ntwo\n");
  assert.equal(client.files.has(path("new")), false);
});

test("patch validates every hunk and destination before any write", async () => {
  const { client, tools, path } = setup();
  client.files.set(path("a"), Buffer.from("original\n"));
  for (const bad of [
    "*** Add File: new\n+hello\n*** Update File: a\n@@\n-missing\n+new",
    "*** Add File: new\n+hello\n*** Add File: ../outside\n+outside",
    "*** Add File: a\n+overwrite",
    "*** Update File: a\n*** Move to: a\n@@\n-original\n+new\n*** Delete File: a",
  ]) {
    await assert.rejects(tools.apply_patch.execute({ patchText: `*** Begin Patch\n${bad}\n*** End Patch` }, context()));
    assert.equal(client.files.get(path("a")).toString(), "original\n");
    assert.equal(client.files.has(path("new")), false);
  }
});

test("patch can delete binary files and exposes a relative path in the native card", async () => {
  const { client, tools, path } = setup();
  client.files.set(path("binary"), Buffer.from([0, 255, 1]));
  const result = await tools.apply_patch.execute({ patchText: "*** Begin Patch\n*** Delete File: binary\n*** End Patch" }, context());
  assert.equal(client.files.has(path("binary")), false);
  assert.equal(result.metadata.files[0].relativePath, "binary");
  assert.match(result.metadata.files[0].patch, /Binary file deleted/);
});

test("patch preserves CRLF and trailing newline and refuses ambiguous hunks", () => {
  const patch = parsePatch("*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** End Patch")[0];
  assert.equal(applyHunks("old\r\n", patch.hunks), "new\r\n");
  assert.equal(applyHunks("old", patch.hunks), "new");
  assert.throws(() => applyHunks("old\nold\n", patch.hunks), /ambiguous/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Update File: a\n@@\n*** End Patch"), /Empty hunk/);
});

test("file tools reject stale observations and blind overwrites until the file is read again", async () => {
  const { client, tools, path } = setup();
  client.files.set(path("a"), Buffer.from("original"));
  await assert.rejects(tools.write.execute({ filePath: "a", content: "blind" }, context()), /Read .* before overwriting/);
  await tools.read.execute({ filePath: "a" }, context());
  client.files.set(path("a"), Buffer.from("external change"));
  await assert.rejects(tools.edit.execute({ filePath: "a", oldString: "external", newString: "lost" }, context()), /changed since/);
  await assert.rejects(tools.apply_patch.execute({ patchText: "*** Begin Patch\n*** Delete File: a\n*** End Patch" }, context()), /changed since/);
  await tools.read.execute({ filePath: "a" }, context());
  await tools.write.execute({ filePath: "a", content: "observed replacement" }, context());
  assert.equal(client.files.get(path("a")).toString(), "observed replacement");
  client.files.delete(path("a"));
  await assert.rejects(tools.read.execute({ filePath: "a" }, context()));
  await tools.write.execute({ filePath: "a", content: "recreated" }, context());
  assert.equal(client.files.get(path("a")).toString(), "recreated");
});
