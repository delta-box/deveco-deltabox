import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsArgv } from "../dist/windows.js";

// Exercise real Windows processes without requiring WinFsp or MXC on hosted CI.
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "deveco-windows-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (argv, env = {}) => {
    const [exe, ...args] = windowsArgv(argv);
    const result = spawnSync(exe, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000 });
    if (result.error) throw result.error;
    return result;
  };
  return { root, run };
}

test("Windows file helpers preserve literal paths and include directories in find", { skip: process.platform !== "win32" }, (t) => {
  const { root, run } = setup(t);
  const file = join(root, "中文 ' $; notes.txt");
  writeFileSync(file, "original");
  mkdirSync(join(root, "nested"));
  assert.equal(run(["test", "-e", file]).status, 0);
  assert.equal(run(["test", "-d", file]).status, 1);
  assert.equal(run(["test", "-d", join(root, "nested")]).status, 0);
  assert.equal(run(["sh", "-c", 'test ! -e "$1" && test ! -L "$1"', "deltabox-patch", file]).status, 1);
  assert.match(run(["ls", "-1A", "--", root]).stdout, /中文 ' \$; notes.txt/);
  const found = run(["find", root, "-name", "nested"]);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /nested/);
  assert.equal(run(["rm", "--", file]).status, 0);
  assert.equal(run(["test", "-e", file]).status, 1);
  assert.equal(run(["sh", "-c", 'test ! -e "$1" && test ! -L "$1"', "deltabox-patch", file]).status, 0);
});

test("Windows shell runs PowerShell with literal environment values and reports errors", { skip: process.platform !== "win32" }, (t) => {
  const { root, run } = setup(t);
  const value = "中文 $() ' ; ` literal";
  const result = run(["bash", "-c", "Set-Content -LiteralPath 'shell.txt' -Value $env:DELTABOX_TEST_VALUE -NoNewline"], { DELTABOX_TEST_VALUE: value });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, "shell.txt"), "utf8"), value);
  assert.notEqual(run(["bash", "-c", "throw 'expected failure'"]).status, 0);
});
