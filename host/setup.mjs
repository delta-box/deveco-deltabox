#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, cpSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { installAdapter } from "./adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { source: { type: "string" }, bun: { type: "string", default: "bun" }, "check": { type: "boolean" }, "test-build": { type: "boolean" } } });
const upstream = JSON.parse(readFileSync(join(here, "upstream.json"), "utf8"));
const patch = join(here, "deveco-code.patch");
const source = resolve(values.source ?? join(here, ".build", "source"));
const run = (bin, args, cwd = source) => execFileSync(bin, args, { cwd, stdio: "inherit" });
if (!["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Unsupported build host.");
if (!existsSync(source)) {
  mkdirSync(dirname(source), { recursive: true });
  run("git", ["clone", "--no-checkout", upstream.repository, source], dirname(source));
  run("git", ["checkout", "--detach", upstream.revision]);
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
if (revision !== upstream.revision) throw new Error(`Expected upstream ${upstream.revision}; got ${revision}. Supply a separate checkout at the pinned revision.`);
const adapterSha256 = installAdapter(source, true);
const applicable = spawnSync("git", ["apply", "--check", patch], { cwd: source });
if (applicable.status === 0) {
  if (!values.check) run("git", ["apply", patch]);
} else if (spawnSync("git", ["apply", "--reverse", "--check", patch], { cwd: source }).status !== 0) {
  throw new Error(`Host patch does not apply cleanly. No files were changed.\n${applicable.stderr}`);
}
if (values.check) { console.log(`Host patch verified against ${revision}`); process.exit(); }
installAdapter(source);
const bunDir = /[\\/]/.test(values.bun) ? dirname(resolve(values.bun)) : undefined;
if (bunDir) process.env.PATH = `${bunDir}${delimiter}${process.env.PATH ?? ""}`;
run(values.bun, ["install", "--frozen-lockfile"]);
run(values.bun, ["run", "script/build.ts", "--single", "--skip-install", ...(values["test-build"] ? ["--skip-agreement"] : [])], join(source, "packages/opencode"));
const distribution = join(source, "packages/opencode/dist", `deveco-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`);
const binaryName = process.platform === "win32" ? "deveco.exe" : "deveco";
if (!existsSync(join(distribution, "bin", binaryName))) throw new Error(`Build did not produce ${distribution}`);
const output = join(here, "..", ".local", values["test-build"] ? "deveco-code-test" : "deveco-code");
mkdirSync(dirname(output), { recursive: true });
// Replacing a running Mach-O executable in place can leave macOS using a stale
// code-signature cache. Copy to a new inode and rename it over the old binary.
const executable = join(distribution, "bin", binaryName);
cpSync(distribution, output, { recursive: true, filter: (source) => source !== executable });
const staging = mkdtempSync(join(output, "bin/.deltabox-install-"));
try {
  cpSync(executable, join(staging, binaryName));
  renameSync(join(staging, binaryName), join(output, "bin", binaryName));
} finally { rmSync(staging, { recursive: true, force: true }); }
run(join(output, "bin", binaryName), ["--version"]);
writeFileSync(join(output, "deltabox-build.json"), JSON.stringify({
  ...upstream, adapterSha256, adapter: "built-in", patchSha256: createHash("sha256").update(readFileSync(patch)).digest("hex"),
  platform: process.platform, arch: process.arch, testBuild: Boolean(values["test-build"]), builtAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`Built patched DevEco Code: ${join(output, "bin", binaryName)}`);
