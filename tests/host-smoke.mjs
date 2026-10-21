import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Use DevEco's official debug-tool context without model accounts or accepting
// product terms on a user's behalf. The fixture calls the production tool objects.
test("official DevEco runs native tools, commit and abort through its plugin context", { skip: !process.env.DEVECO_BIN, timeout: 60000 }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "deltabox-deveco-host-"));
  const project = join(root, "project");
  mkdirSync(project);
  const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `
import plugin from ${JSON.stringify(new URL("../dist/plugin.js", import.meta.url).href)};
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default async (input) => {
  const hooks = await plugin(input);
  hooks.tool.deltabox_smoke = {
    description: "Exercise the production adapter in an isolated test project",
    args: {},
    async execute(_args, ctx) {
      const run = async (name, args) => {
        await hooks["tool.execute.before"]({tool:name,sessionID:ctx.sessionID,callID:"smoke"}, {args});
        return hooks.tool[name].execute(args, ctx);
      };
      const command = async (name) => {
        const output = {parts: [{type:"text",text:"smoke"}]};
        await hooks["command.execute.before"]({command:name,sessionID:ctx.sessionID,arguments:""}, output);
        return output.result.text;
      };
      try {
        await run("write", {filePath:"smoke.txt",content:"draft\\n"});
        await run("edit", {filePath:"smoke.txt",oldString:"draft",newString:"reviewable"});
        await run("shell", {command:"printf 'command\\\\n' > command.txt"});
        assert.match(await run("read", {filePath:"smoke.txt"}), /1: reviewable/);
        assert.equal(existsSync(join(input.directory,"smoke.txt")), false);
        assert.equal(existsSync(join(input.directory,"command.txt")), false);
        assert.match(await command("sandbox-review"), /smoke.txt/);
        await command("sandbox-commit");
        assert.equal(readFileSync(join(input.directory,"smoke.txt"),"utf8"), "reviewable\\n");
        await run("write", {filePath:"smoke.txt",content:"discard"});
        await command("sandbox-abort");
        assert.match(await run("read", {filePath:"smoke.txt"}), /1: reviewable/);
        await run("write", {filePath:"dispose.txt",content:"discard"});
        await hooks.dispose();
        assert.equal(existsSync(join(input.directory,"dispose.txt")), false);
        return "Deltabox host smoke passed: read/write/edit/shell, private visibility, commit, abort and cleanup";
      } finally { await hooks.dispose(); }
    },
  };
  return hooks;
};
`);
  writeFileSync(join(project, "deveco.json"), JSON.stringify({
    plugin: [pathToFileURL(fixture).href],
    permission: "allow", model: "adapter-test/test",
    agent: { build: { model: "adapter-test/test" } },
    provider: { "adapter-test": {
      npm: "@ai-sdk/openai-compatible", name: "Local adapter test",
      options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "unused" },
      models: { test: { name: "Local test", limit: { context: 128000, output: 8192 } } },
    } },
  }));
  writeFileSync(join(project, "deltabox.json"), JSON.stringify({
    stateDir: join(root, "backend-state"), runtimeDir: join(root, "backend-runtime"),
    filesystem: { mode: "copy-private", require: true },
  }));
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SHELL", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", DEVECO_TEST_HOME: "home" })) {
    env[key] = join(root, folder);
    mkdirSync(env[key], { recursive: true });
  }
  for (const key of ["DEVECO_DISABLE_DEFAULT_PLUGINS", "DEVECO_DISABLE_DEFAULT_SKILLS", "DEVECO_DISABLE_EXTERNAL_SKILLS", "DEVECO_DISABLE_CLAUDE_CODE", "DEVECO_DISABLE_MODELS_FETCH", "DEVECO_DISABLE_AUTOUPDATE", "DEVECO_DISABLE_CREDENTIAL_KEYCHAIN"]) env[key] = "true";
  const child = spawn(process.env.DEVECO_BIN, ["debug", "agent", "build", "--tool", "deltabox_smoke", "--params", "{}"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr || stdout);
    assert.match(stdout, /Deltabox host smoke passed/);
  } finally {
    clearTimeout(timer);
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
