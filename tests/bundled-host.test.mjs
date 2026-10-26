import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installAdapter } from "../host/adapter.mjs";

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "deltabox-bundled-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("host adapter installation is inspectable, repeatable and refuses local edits", (t) => {
  const root = temporary(t);
  const target = join(root, "packages/opencode/src/plugin/deltabox");
  const digest = installAdapter(root, true);
  assert.equal(existsSync(target), false);
  assert.equal(installAdapter(root), digest);
  assert.equal(installAdapter(root, true), digest);
  assert.equal(installAdapter(root), digest);
  const native = readFileSync(new URL("../host/adapter/language.ts", import.meta.url));
  assert.deepEqual(readFileSync(join(target, "language.ts")), native);
  writeFileSync(join(target, "language.ts"), "local change");
  assert.throws(() => installAdapter(root), /Adapter source differs/);
  assert.equal(readFileSync(join(target, "language.ts"), "utf8"), "local change");
});

test("launcher enables the built-in adapter and preserves unrelated settings", (t) => {
  const root = temporary(t);
  const entry = new URL("../dist/plugin.js", import.meta.url).href;
  const launcher = fileURLToPath(new URL("../bin/deveco-deltabox.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [launcher, "-e", "console.log(process.env.DEVECO_CONFIG_CONTENT)"], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      DEVECO_DELTABOX_BIN: process.execPath,
      DEVECO_CONFIG_CONTENT: JSON.stringify({ model: "example/model", lsp: true, formatter: true,
        plugin: [entry, "deveco-deltabox", ["deveco-deltabox@0.1.0", {}], ["another-plugin", { keep: true }]] }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { model: "example/model", lsp: true, formatter: true,
    deltabox: true, plugin: [["another-plugin", { keep: true }]] });
});
