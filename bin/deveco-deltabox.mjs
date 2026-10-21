#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.DEVECO_DELTABOX_BIN ?? join(root, ".local/deveco-code/bin", process.platform === "win32" ? "deveco.exe" : "deveco");
if (!existsSync(binary) || !existsSync(join(root, "dist/plugin.js"))) {
  console.error("Build the plugin and patched host first: npm run build && npm run setup:host (see host/README.md).");
  process.exit(1);
}
const config = JSON.parse(process.env.DEVECO_CONFIG_CONTENT ?? "{}");
if (!config || Array.isArray(config) || typeof config !== "object" || (config.plugin && !Array.isArray(config.plugin))) throw new Error("DEVECO_CONFIG_CONTENT must be a JSON configuration object.");
const plugin = pathToFileURL(join(root, "dist/plugin.js")).href;
config.plugin = [...(config.plugin ?? []).filter((value) => value !== plugin), plugin];
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env: {
  ...process.env, DEVECO_CONFIG_CONTENT: JSON.stringify(config), DEVECO_DISABLE_AUTOUPDATE: "true",
  ...(existsSync(join(root, ".local/deltabox.json")) && !process.env.DEVECO_DELTABOX_CONFIG ? { DEVECO_DELTABOX_CONFIG: join(root, ".local/deltabox.json") } : {}),
} });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
