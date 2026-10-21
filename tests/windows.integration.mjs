import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Runtime } from "../dist/runtime.js";
import { parseConfig } from "../dist/config.js";
import { makeTools } from "../dist/tools.js";
import { context, approve } from "./helpers.mjs";

const require = createRequire(import.meta.url);
for (const transport of ["native", "serve", "cli"]) test(`Windows ${transport}: private tools, review acceptance and rollback`, { skip: process.platform !== "win32", timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "deveco-windows-"));
  const project = join(root, "project"); mkdirSync(project);
  writeFileSync(join(project, "original.txt"), "original\n");
  const rt = new Runtime(project, parseConfig({ transport, bin: require("deltabox-lite").binaryPath(), policy: resolve(".local/windows-policy.toml"), stateDir: join(root,"state"), runtimeDir: join(root,"runtime"), filesystem: {mode:"cbcow-private",require:true} }), { parent: async()=>undefined, notify: async()=>{} });
  const tools=makeTools(()=>rt), ctx=context();
  try {
    await tools.write.execute({filePath:"空 格 ' $;.txt",content:"draft\n"},ctx);
    assert.equal(existsSync(join(project,"空 格 ' $;.txt")),false);
    await tools.edit.execute({filePath:"空 格 ' $;.txt",oldString:"draft",newString:"reviewed"},ctx);
    assert.match(await tools.read.execute({filePath:"original.txt"},ctx),/original/);
    await tools.apply_patch.execute({patchText:"*** Begin Patch\n*** Update File: original.txt\n*** Move to: moved.txt\n@@\n-original\n+changed\n*** Add File: extra.txt\n+extra\n*** End Patch"},ctx);
    const shell=await tools.shell.execute({command:"Set-Content -LiteralPath shell.txt -Value $env:DELTABOX_TEST_VALUE -NoNewline"},{...ctx,shellEnv:async()=>({DELTABOX_TEST_VALUE:"literal $() ' 中文"})});
    assert.equal(shell.metadata.exit,0,shell.output);
    assert.match(await tools.grep.execute({pattern:"reviewed",include:"*.txt"},ctx),/reviewed/);
    assert.match(await tools.glob.execute({pattern:"*.txt"},ctx),/extra.txt/);
    assert.match(await tools.list.execute({},ctx),/moved.txt/);
    assert.match(await tools.find.execute({pattern:"*.txt"},ctx),/shell.txt/);
    await rt.stopping({...ctx,ask:approve(rt.gate,"root")});
    assert.equal(readFileSync(join(project,"shell.txt"),"utf8"),"literal $() ' 中文");
    assert.equal(readFileSync(join(project,"空 格 ' $;.txt"),"utf8"),"reviewed\n");
    assert.equal(existsSync(join(project,"original.txt")),false);
    await tools.write.execute({filePath:"discard.txt",content:"discard"},ctx);
    await rt.stopping({...ctx,ask:approve(rt.gate,"root","reject")});
    assert.equal(existsSync(join(project,"discard.txt")),false);
    await tools.write.execute({filePath:"cleanup.txt",content:"discard"},ctx);
  } finally {
    await rt.dispose();
    assert.equal(existsSync(join(project,"cleanup.txt")),false);
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
