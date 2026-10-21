import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeltaboxClient } from "../dist/client.js";
import { parseConfig } from "../dist/config.js";

function server(t, body, config = {}) {
  const project = mkdtempSync(join(tmpdir(), "deveco-transport-"));
  const bin = join(project, process.platform === "win32" ? "backend.cjs" : "backend");
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync("starts", process.pid + "\\n");\n${body}`, { mode: 0o755 });
  const client = new DeltaboxClient(project, parseConfig({ transport: "serve", bin: process.platform === "win32" ? process.execPath : bin, timeoutMs: 2000, ...config }));
  // Windows does not execute shebang files. Node runs the command-named fixture.
  if (process.platform === "win32") for (const name of ["serve", "session"]) writeFileSync(join(project, name), readFileSync(bin));
  t.after(async () => { await client.stop(); rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { client, project };
}

test("a failed server start is cleaned up even without a session id", async (t) => {
  const { client, project } = server(t, `require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const {id} = JSON.parse(line); console.log(JSON.stringify({id,error:{message:"provider unavailable"}}));
  });`);
  await assert.rejects(client.start(), /provider unavailable/);
  const pid = Number(readFileSync(join(project, "starts"), "utf8").trim());
  await client.stop();
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("backend remained alive after failed startup cleanup");
});

test("invalid RPC output poisons the connection without silently restarting it", async (t) => {
  const { client, project } = server(t, `process.stdin.on("data", () => console.log("not json"));`);
  await assert.rejects(client.start(), /JSON/);
  await assert.rejects(client.start(), /JSON/);
  assert.equal(readFileSync(join(project, "starts"), "utf8").trim().split("\n").length, 1);
});

for (const transport of ["serve", "cli"]) {
  test(`${transport} timeout keeps the ambiguous outcome failed`, async (t) => {
    const { client } = server(t, "setInterval(() => {}, 1000);", { transport, timeoutMs: 150 });
    await assert.rejects(client.start(), /timed out/);
    await assert.rejects(client.start(), /timed out/);
  });
}
