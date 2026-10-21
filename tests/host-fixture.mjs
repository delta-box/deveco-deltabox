import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function until(read, accept = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await delay(40);
  }
  throw new Error(`Condition timed out: ${JSON.stringify(value)}`);
}

// A deterministic local model exercises the real provider, prompt loop, tool
// registry and permission service. No model account or external API is used.
export async function startHost() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "deltabox-deveco-e2e-"));
  const project = join(root, "project");
  mkdirSync(project);
  let requests = 0;
  const steps = new Map();
  const model = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests++;
      const user = [...body.messages].reverse().find((m) => m.role === "user");
      const label = /\[case:([\w-]+)\]/.exec(JSON.stringify(user?.content))?.[1];
      let call;
      if (label && body.tools?.length) {
        const step = steps.get(label) ?? 0;
        steps.set(label, step + 1);
        const plan = label.startsWith("mode-") ? [
          ["write", { filePath: `${label}-first.txt`, content: "first\n" }],
          ["read", { filePath: `${label}-first.txt` }],
          ["shell", { command: process.platform === "win32" ? "Write-Output ok" : ":", description: "Read-only command produces no changes" }],
          ["write", { filePath: `${label}-second.txt`, content: "second\n" }],
        ] : label === "subagent" ? [
          ["task", { description: "Exercise a foreground child agent", prompt: "[case:child] Write child.txt for the Deltabox test.", subagent_type: "general" }],
        ] : label === "accept" ? [
          ["write", { filePath: "accept.txt", content: "draft\n" }],
          ["edit", { filePath: "accept.txt", oldString: "draft", newString: "reviewed" }],
          ["apply_patch", { patchText: "*** Begin Patch\n*** Add File: patch.txt\n+patched\n*** End Patch" }],
          ["shell", { command: process.platform === "win32" ? "Set-Content -LiteralPath environment.txt -Value $env:DELTABOX_E2E_ENV -NoNewline" : "printf '%s' \"$DELTABOX_E2E_ENV\" > environment.txt" + (process.env.DEVECO_CLI_BIN ? `; '${process.env.DEVECO_CLI_BIN.replaceAll("'", "'\\''")}' --version` : ""), description: "Check toolchain environment through Deltabox" }],
        ] : [["write", { filePath: `${label}.txt`, content: `${label}\n` }]];
        call = plan[step];
      }
      const delta = call
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
        : { role: "assistant", content: "Local model finished." };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `chat_${requests}`, object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk(delta) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const plugin = new URL("../dist/plugin.js", import.meta.url).href;
  const fixture = join(root, "plugin.mjs");
  writeFileSync(fixture, `import plugin from ${JSON.stringify(plugin)};\nexport default async input => { const hooks = await plugin(input); return {...hooks, "shell.env": async (_input, output) => { output.env.DELTABOX_E2E_ENV = "literal $() ' \\\" value"; }}; };\n`);
  writeFileSync(join(project, "deveco.json"), JSON.stringify({
    plugin: [pathToFileURL(fixture).href], permission: "allow", model: "adapter-test/test", small_model: "adapter-test/test",
    provider: { "adapter-test": { npm: "@ai-sdk/openai-compatible", name: "Local adapter test", options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "unused" }, models: { test: { name: "Local test", tool_call: true, limit: { context: 128000, output: 8192 } } } } },
  }));
  writeFileSync(join(project, "deltabox.json"), JSON.stringify({
    stateDir: join(root, "backend-state"), runtimeDir: join(root, "backend-runtime"),
    ...(process.env.DELTABOX_TEST_POLICY ? { policy: process.env.DELTABOX_TEST_POLICY } : {}),
    filesystem: { mode: process.platform === "win32" ? "cbcow-private" : "copy-private", require: true },
  }));
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "SystemRoot", "WINDIR", "SystemDrive", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", DEVECO_TEST_HOME: "home" })) {
    env[key] = join(root, folder);
    mkdirSync(env[key], { recursive: true });
  }
  for (const key of ["DEVECO_DISABLE_DEFAULT_PLUGINS", "DEVECO_DISABLE_DEFAULT_SKILLS", "DEVECO_DISABLE_EXTERNAL_SKILLS", "DEVECO_DISABLE_CLAUDE_CODE", "DEVECO_DISABLE_MODELS_FETCH", "DEVECO_DISABLE_AUTOUPDATE", "DEVECO_DISABLE_CREDENTIAL_KEYCHAIN"]) env[key] = "true";
  const child = spawn(process.env.DEVECO_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  const close = async () => {
    if (url && child.exitCode === null) {
      await fetch(`${url}/instance/dispose`, { method: "POST", headers: { "x-deveco-directory": project }, signal: AbortSignal.timeout(10000) }).catch(() => {});
    }
    child.kill("SIGTERM");
    if (child.exitCode === null) await Promise.race([once(child, "exit"), delay(3000).then(() => child.kill("SIGKILL"))]);
    model.closeAllConnections(); model.close();
    if (!process.env.DEVECO_E2E_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else writeFileSync(join(root, "host.log"), log);
  };
  let url;
  try {
    url = await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host exited (${child.exitCode ?? child.signalCode}).\n${log}`);
      return /listening on (http:\/\/[^\s]+)/.exec(log)?.[1];
    });
  } catch (error) { await close(); throw error; }
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", "x-deveco-directory": project }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${log.slice(-3000)}`);
    return text ? JSON.parse(text) : undefined;
  };
  return { root, project, url, env, api, close, requests: () => requests, log: () => log };
}
