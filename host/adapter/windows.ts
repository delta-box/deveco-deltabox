// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import { Shell, PS_ENCODING_PREAMBLE } from "@opencode-ai/core/shell"
import { which } from "@opencode-ai/core/util/which"

/** Keep paths as separate argv values so Deltabox can map them into its view. */
export function windowsArgv(argv: string[], cwd: string, shell?: string): string[] {
  const node = (script: string, ...args: string[]) => [
    which(process.platform === "win32" ? "node.exe" : "node") ?? "node",
    "-e",
    script,
    "--",
    ...args,
  ]
  const fs = "const fs=require('node:fs'); const p=process.argv[1]; "
  if (argv[0] === "bash" && argv[1] === "-c") {
    const selected = Shell.preferred(shell)
    if (!Shell.ps(selected)) return [selected, ...Shell.args(selected, argv[2], cwd)]
    const preamble =
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
      PS_ENCODING_PREAMBLE +
      "Set-Location -LiteralPath ([Environment]::CurrentDirectory); "
    return [
      selected,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(preamble + argv[2], "utf16le").toString("base64"),
    ]
  }
  if (argv[0] === "test" && ["-e", "-d"].includes(argv[1])) {
    return node(
      fs +
        "try { const s=fs.statSync(p); process.exit(process.argv[2]==='-d'&&!s.isDirectory()?1:0); } catch(e) { if(e.code==='ENOENT'||e.code==='ENOTDIR') process.exit(1); throw e; }",
      argv[2],
      argv[1],
    )
  }
  if (argv[0] === "sh" && argv[3] === "deltabox-patch") {
    return node(
      fs + "try { fs.lstatSync(p); process.exit(1); } catch(e) { if(e.code==='ENOENT') process.exit(0); throw e; }",
      argv[4],
    )
  }
  if (argv[0] === "rm" && argv[1] === "--") return node(fs + "fs.unlinkSync(p);", argv[2])
  if (argv[0] === "ls")
    return node(
      fs + "for(const e of fs.readdirSync(p,{withFileTypes:true})) console.log(e.name+(e.isDirectory()?'/':''));",
      argv.at(-1)!,
    )
  if (argv[0] === "find")
    return node(
      fs +
        "const path=require('node:path'); function walk(p) { if(path.matchesGlob(path.basename(p),process.argv[2])) console.log(p); if(fs.lstatSync(p).isDirectory()) for(const e of fs.readdirSync(p,{withFileTypes:true})) if(!e.isSymbolicLink()) walk(path.join(p,e.name)); } walk(p);",
      argv[1],
      argv[3],
    )
  return argv
}
