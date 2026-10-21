import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../dist/runtime.js";
import { parseConfig } from "../dist/config.js";
import { makeTools } from "../dist/tools.js";
import { context } from "./helpers.mjs";

const bin = process.env.DELTABOX_BIN;
const addon = process.env.DELTABOX_NATIVE_ADDON;
const devecoCli = process.env.DEVECO_CLI_BIN;
for (const transport of ["native", "serve", "cli"]) {
  for (const mode of ["cbcow-through", "cbcow-private", "copy-private"]) {
    test(`real runtime: ${transport}/${mode} shares read, shell, edit, patch, commit and abort`, { skip: !bin ? "Set DELTABOX_BIN to run integration tests" : false }, async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "deveco-deltabox-live-"));
      const project = join(root, "project");
      mkdirSync(project);
      writeFileSync(join(project, "original.txt"), "original\n");
      const config = parseConfig({ transport, bin, nativeAddon: addon ?? null, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), filesystem: { mode, require: true } });
      const rt = new Runtime(project, config, { parent: async () => undefined, notify: async () => {} });
      const tools = makeTools(() => rt);
      const ctx = context();
      let cleaned = false;
      try {
        await tools.write.execute({ filePath: "new.txt", content: "pending\n" }, ctx);
        assert.equal(existsSync(join(project, "new.txt")), mode === "cbcow-through");
        assert.match(await tools.read.execute({ filePath: "new.txt" }, ctx), /pending/);
        await tools.edit.execute({ filePath: "new.txt", oldString: "pending", newString: "accepted" }, ctx);
        await tools.shell.execute({ command: "printf '%s\\n' \"$DELTABOX_TEST_VALUE\" > shell.txt" }, { ...ctx, shellEnv: async () => ({ DELTABOX_TEST_VALUE: "shell output" }) });
        const pending = await rt.command("root", "sandbox-review", "");
        assert.match(pending, /new.txt/);
        assert.match(pending, /shell.txt/);
        await rt.command("root", "sandbox-commit", "");
        assert.equal(readFileSync(join(project, "new.txt"), "utf8"), "accepted\n");
        assert.equal(readFileSync(join(project, "shell.txt"), "utf8"), "shell output\n");

        const patchText = "*** Begin Patch\n*** Update File: original.txt\n*** Move to: moved.txt\n@@\n-original\n+changed\n*** Add File: another.txt\n+another\n*** Delete File: shell.txt\n*** End Patch";
        await tools.apply_patch.execute({ patchText }, ctx);
        assert.match(await tools.read.execute({ filePath: "moved.txt" }, ctx), /changed/);
        await rt.command("root", "sandbox-skip", "");
        await tools.write.execute({ filePath: "later.txt", content: "later" }, ctx);
        await rt.command("root", "sandbox-abort", "");
        assert.equal(readFileSync(join(project, "original.txt"), "utf8"), "original\n");
        assert.equal(readFileSync(join(project, "new.txt"), "utf8"), "accepted\n");
        assert.equal(existsSync(join(project, "moved.txt")), false);
        assert.equal(existsSync(join(project, "later.txt")), false);
        assert.equal(existsSync(join(project, "shell.txt")), true);
        await tools.write.execute({ filePath: "dispose.txt", content: "pending" }, ctx);
        await rt.dispose();
        cleaned = true;
        assert.equal(existsSync(join(project, "dispose.txt")), false);
      } finally {
        if (!cleaned) await rt.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("installed DevEco CLI scaffolds a HarmonyOS app inside the reviewable view", { skip: !bin || !devecoCli, timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "deveco-deltabox-cli-"));
  const project = join(root, "project");
  mkdirSync(project);
  const rt = new Runtime(project, parseConfig({ bin, nativeAddon: addon ?? null, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), filesystem: { mode: "copy-private", require: true } }), { parent: async () => undefined, notify: async () => {} });
  const tools = makeTools(() => rt);
  const ctx = { ...context(), shellEnv: async () => ({ DEVECO_CLI_DISABLE_UPDATE: "all", ...Object.fromEntries(["DEVECO_CLI_STUDIO_PATH", "DEVECO_CLI_CLT_PATH"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])) }) };
  try {
    const command = `'${devecoCli.replaceAll("'", "'\\''")}' create --project-path demo --app-name DeltaboxTest --bundle-name com.example.deltaboxtest --api-level 17`;
    const output = await tools.shell.execute({ command }, ctx);
    if (output.metadata.exit === 1 && output.output.includes("DevEco Studio installation not found")) {
      t.skip("DevEco CLI executed, but scaffolding requires a local DevEco Studio or Command Line Tools installation.");
      return;
    }
    assert.equal(output.metadata.exit, 0, output.output);
    assert.equal(existsSync(join(project, "demo")), false);
    assert.match(await tools.read.execute({ filePath: "demo/AppScope/app.json5" }, ctx), /com\.example\.deltaboxtest/);
    assert.match(await rt.command("root", "sandbox-review", ""), /AppScope/);
    await rt.command("root", "sandbox-commit", "");
    assert.match(readFileSync(join(project, "demo/AppScope/app.json5"), "utf8"), /com\.example\.deltaboxtest/);
    await tools.shell.execute({ command: "rm -rf demo" }, ctx);
    await rt.command("root", "sandbox-abort", "");
    assert.ok(existsSync(join(project, "demo/entry/src/main/ets/pages/Index.ets")));
  } finally { await rt.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("real native file operations deny symlinks escaping the workspace", { skip: !bin }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "deveco-deltabox-path-"));
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(root, "outside.txt"), "keep");
  symlinkSync(join(root, "outside.txt"), join(project, "link.txt"));
  const rt = new Runtime(project, parseConfig({ bin, nativeAddon: addon ?? null, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), filesystem: { mode: "copy-private" } }), { parent: async () => undefined, notify: async () => {} });
  try {
    const tools = makeTools(() => rt);
    await assert.rejects(tools.write.execute({ filePath: "link.txt", content: "escaped" }, context()));
    assert.equal(readFileSync(join(root, "outside.txt"), "utf8"), "keep");
  } finally {
    await rt.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["cbcow-private", "copy-private"]) {
  test(`real ${mode} idle sessions refresh the snapshot for the next conversation`, { skip: !bin }, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "deveco-deltabox-idle-"));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "file.txt"), "original");
    const rt = new Runtime(project, parseConfig({ bin, nativeAddon: addon ?? null, stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), filesystem: { mode, require: true } }), { parent: async () => undefined, notify: async () => {} });
    try {
      const tools = makeTools(() => rt);
      assert.match(await tools.read.execute({ filePath: "file.txt" }, context()), /original/);
      await rt.idle("root");
      writeFileSync(join(project, "file.txt"), "host edit between conversations");
      assert.match(await tools.read.execute({ filePath: "file.txt" }, context("next")), /host edit between conversations/);
    } finally {
      await rt.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
