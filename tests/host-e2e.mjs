import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startHost, until } from "./host-fixture.mjs";

test("patched DevEco prompt loop waits for Deltabox review, renders diffs and settles commit/reject/cancel", { skip: !process.env.DEVECO_BIN, timeout: 180000 }, async () => {
  const host = await startHost();
  const { api, project } = host;
  try {
    const session = await api("/session", { title: "Deltabox host integration" });
    const command = (command) => api(`/session/${session.id}/command`, { command, arguments: "" });
    for (const label of ["accept", "reject", "cancel"]) {
      let finished = false;
      const running = api(`/session/${session.id}/message`, { parts: [{ type: "text", text: `[case:${label}] Apply the requested local test change.` }] }).then((result) => { finished = true; return result; });
      // Handle failures immediately so a failed prompt does not become an
      // unhandled rejection while the permission assertion gathers diagnostics.
      running.catch(() => {});
      const permission = await until(async () => {
        const pending = await api("/permission");
        if (finished && !pending.length) throw new Error(`Prompt ended without review: ${JSON.stringify(await running)}\n${host.log().slice(-4000)}`);
        return pending.find((p) => p.sessionID === session.id && p.permission === "deltabox_review");
      });
      assert.equal(finished, false, "prompt must wait for review");
      assert.match(permission.patterns.join("\n"), new RegExp(`${label}.txt`));
      assert.equal(existsSync(join(project, `${label}.txt`)), false, "private writes must stay private before approval");
      const status = await api("/session/status");
      assert.equal(status[session.id].type, "busy");
      if (label === "cancel") {
        await api(`/session/${session.id}/abort`, {});
        await running;
        await until(() => api("/permission"), (pending) => pending.length === 0);
        const review = await command("sandbox-review");
        assert.match(review.parts[0].text, /cancel.txt/);
        await command("sandbox-abort");
        assert.equal(existsSync(join(project, "cancel.txt")), false);
      } else {
        await api(`/permission/${permission.id}/reply`, { reply: label === "reject" ? "reject" : "once" });
        await running;
        assert.equal(existsSync(join(project, `${label}.txt`)), label !== "reject");
      }
      if (label === "accept") {
        const history = await api(`/session/${session.id}/message`);
        const tools = history.flatMap((message) => message.parts).filter((part) => part.type === "tool");
        assert.ok(tools.every((part) => part.state.status === "completed"), JSON.stringify(tools));
        assert.equal(readFileSync(join(project, "accept.txt"), "utf8"), "reviewed\n");
        assert.equal(readFileSync(join(project, "patch.txt"), "utf8"), "patched\n");
        assert.equal(readFileSync(join(project, "environment.txt"), "utf8"), "literal $() ' \" value");
        const edit = tools.find((part) => part.tool === "edit");
        assert.equal(edit.state.metadata.filediff.before, "draft\n");
        assert.equal(edit.state.metadata.filediff.after, "reviewed\n");
        const patch = tools.find((part) => part.tool === "apply_patch");
        assert.equal(patch.state.metadata.files[0].relativePath, "patch.txt");
        if (process.env.DEVECO_CLI_BIN) assert.match(tools.find((part) => part.tool === "shell").state.output, /\d+\.\d+\.\d+/);
        assert.equal(tools.some((part) => /Keep all|Accepted \d+ change/.test(part.state.output)), false, "review must not contaminate model tool output");
      }
      const count = host.requests();
      const result = await command("sandbox-status");
      assert.match(result.parts[0].text, /pending changes: 0/);
      assert.equal(host.requests(), count, "user slash commands must not call the model");
    }
    const auto = spawn(process.env.DEVECO_BIN, ["run", "--attach", host.url, "--dir", project, "--session", session.id, "--auto", "--format", "json", "[case:auto] Write the automatic approval test file."], { cwd: project, env: host.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    auto.stdout.on("data", (data) => { output += data; });
    auto.stderr.on("data", (data) => { output += data; });
    const timer = setTimeout(() => auto.kill("SIGKILL"), 30000);
    try {
      const [code] = await once(auto, "close");
      assert.equal(code, 0, output);
      assert.equal(readFileSync(join(project, "auto.txt"), "utf8"), "auto\n");
      assert.deepEqual(await api("/permission"), []);
    } finally { clearTimeout(timer); auto.kill(); }

    const parent = api(`/session/${session.id}/message`, { parts: [{ type: "text", text: "[case:subagent] Delegate the file change to a foreground child." }] });
    parent.catch(() => {});
    const childReview = await until(async () => (await api("/permission")).find((p) => p.permission === "deltabox_review"));
    assert.equal(childReview.sessionID, session.id, "only the parent may review the shared scope");
    assert.match(childReview.patterns.join("\n"), /child.txt/);
    assert.equal(existsSync(join(project, "child.txt")), false);
    assert.equal((await api("/permission")).length, 1);
    await api(`/permission/${childReview.id}/reply`, { reply: "once" });
    await parent;
    assert.equal(readFileSync(join(project, "child.txt"), "utf8"), "child\n");

    for (const mode of ["task", "tool", "risky"]) {
      await command("sandbox-abort");
      await api(`/session/${session.id}/command`, { command: "sandbox-mode", arguments: mode });
      const count = host.requests();
      const running = api(`/session/${session.id}/message`, { parts: [{ type: "text", text: `[case:mode-${mode}] Make two changes with read-only operations between them.` }] });
      running.catch(() => {});
      const first = await until(async () => (await api("/permission")).find((p) => p.permission === "deltabox_review"));
      assert.equal(first.metadata.reviewMode, mode);
      assert.equal(first.metadata.pendingChanges, mode === "task" ? 2 : 1);
      assert.equal(host.requests() - count, mode === "task" ? 5 : 1, "task waits for the final answer; tool/risky pause before the next model request");
      assert.equal(existsSync(join(project, `mode-${mode}-first.txt`)), false);
      assert.equal(existsSync(join(project, `mode-${mode}-second.txt`)), false);
      await api(`/permission/${first.id}/reply`, { reply: "once" });
      if (mode !== "task") {
        const second = await until(async () => (await api("/permission")).find((p) => p.permission === "deltabox_review" && p.id !== first.id));
        assert.equal(host.requests() - count, 4, "read and a shell command without changes must not prompt");
        assert.equal(second.metadata.pendingChanges, 1);
        assert.equal(readFileSync(join(project, `mode-${mode}-first.txt`), "utf8"), "first\n");
        assert.equal(existsSync(join(project, `mode-${mode}-second.txt`)), false);
        await api(`/permission/${second.id}/reply`, { reply: "reject" });
      }
      await running;
      assert.equal(readFileSync(join(project, `mode-${mode}-first.txt`), "utf8"), "first\n");
      assert.equal(existsSync(join(project, `mode-${mode}-second.txt`)), mode === "task");
      assert.deepEqual(await api("/permission"), []);
    }
  } finally { await host.close(); }
});
