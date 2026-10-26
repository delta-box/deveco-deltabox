import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Requires the companion test build; uses its deterministic local model fixture.
test("compiled host formats and diagnoses the private view before committing", { skip: !process.env.DEVECO_BIN, timeout: 60000 }, async () => {
  const source = process.env.DEVECO_HOST_SOURCE ?? fileURLToPath(new URL("../host/.build/source", import.meta.url));
  const { startHost } = await import(pathToFileURL(join(source, "packages/opencode/test/plugin/fixtures/deltabox-host.mjs")).href);
  const host = await startHost();
  const lspLog = join(host.root, "language.log");
  const formatLog = join(host.root, "format.log");
  const formatter = join(host.root, "formatter.mjs");
  writeFileSync(formatter, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(formatLog)}, JSON.stringify({ cwd: process.cwd(), file: process.argv[2] }) + "\\n");
writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").trimEnd() + "\\n");`);
  const configFile = join(host.project, "deveco.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.lsp = { mounted: { extensions: [".txt"], command: [process.execPath, join(source, "packages/opencode/test/plugin/fixtures/mounted-lsp.mjs"), lspLog] } };
  config.formatter = { mounted: { extensions: [".txt"], command: [process.execPath, formatter, "$FILE"] } };
  writeFileSync(configFile, JSON.stringify(config));
  try {
    const session = await host.api("/session", { title: "Compiled mounted language integration" });
    await host.api(`/session/${session.id}/message`, { parts: [{ type: "text", text: "[case:accept] Apply the local test change." }] });
    const command = (command) => host.api(`/session/${session.id}/command`, { command, arguments: "" });
    const formatted = readFileSync(formatLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(formatted.length >= 3);
    assert.ok(formatted.every((entry) => resolve(entry.cwd) !== resolve(host.project)));
    const initialized = JSON.parse(readFileSync(lspLog, "utf8").split("\n")[0]);
    assert.notEqual(resolve(initialized.cwd), resolve(host.project));
    await command("sandbox-commit");
    assert.equal(readFileSync(join(host.project, "accept.txt"), "utf8"), "reviewed\n");
    assert.equal(readFileSync(join(host.project, "patch.txt"), "utf8"), "patched\n");
  } finally {
    await host.close();
  }
});
