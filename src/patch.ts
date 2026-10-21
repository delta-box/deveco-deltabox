import type { Client } from "./client.js";
import { fileDiff } from "./file-diff.js";
import { relative } from "node:path";

type Hunk = { anchor?: string; rows: string[]; eof: boolean };
type Patch = { kind: "Add" | "Update" | "Delete"; path: string; move?: string; lines: string[]; hunks: Hunk[] };

export function parsePatch(text: string): Patch[] {
  const lines = text.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") throw new Error("Expected *** Begin Patch / *** End Patch");
  const patches: Patch[] = [];
  let current: Patch | undefined;
  let hunk: Hunk | undefined;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { kind: header[1] as Patch["kind"], path: header[2], lines: [], hunks: [] };
      patches.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) throw new Error(`Invalid patch header: ${line}`);
    if (line.startsWith("*** Move to: ") && current.kind === "Update" && !current.hunks.length && !current.move) {
      current.move = line.slice("*** Move to: ".length);
    } else if (current.kind === "Add" && line.startsWith("+")) {
      current.lines.push(line.slice(1));
    } else if (current.kind === "Update" && (line === "@@" || line.startsWith("@@ "))) {
      hunk = { anchor: line === "@@" ? undefined : line.slice(3), rows: [], eof: false };
      current.hunks.push(hunk);
    } else if (current.kind === "Update" && line === "*** End of File" && hunk) {
      hunk.eof = true;
    } else if (current.kind === "Update" && /^[ +\-]/.test(line)) {
      if (!hunk) { hunk = { rows: [], eof: false }; current.hunks.push(hunk); }
      if (hunk.eof) throw new Error("Unexpected patch content after *** End of File");
      hunk.rows.push(line);
    } else throw new Error(`Unsupported patch line: ${line}`);
  }
  if (!patches.length) throw new Error("Empty patch");
  for (const patch of patches) {
    if (patch.kind === "Update" && !patch.hunks.length && !patch.move) throw new Error(`Empty update: ${patch.path}`);
    if (patch.hunks.some((h) => !h.rows.length)) throw new Error(`Empty hunk: ${patch.path}`);
  }
  return patches;
}

export function applyHunks(text: string, hunks: Hunk[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = text.endsWith("\n");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (trailing || text === "") lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor) {
      const anchor = lines.indexOf(hunk.anchor, cursor);
      if (anchor < 0) throw new Error(`Patch anchor not found: ${hunk.anchor}`);
      cursor = anchor + 1;
    }
    const before = hunk.rows.filter((r) => r[0] !== "+").map((r) => r.slice(1));
    const after = hunk.rows.filter((r) => r[0] !== "-").map((r) => r.slice(1));
    let index = hunk.eof ? lines.length - before.length : cursor;
    if (before.length) {
      const matches: number[] = [];
      for (let i = index; i <= lines.length - before.length; i++) {
        if (before.every((line, n) => lines[i + n] === line)) matches.push(i);
        if (hunk.eof) break;
      }
      if (matches.length !== 1) throw new Error(`Patch context ${matches.length ? "is ambiguous; add more context" : "was not found"}`);
      index = matches[0];
    }
    if (index < cursor) throw new Error("Patch hunks are out of order");
    lines.splice(index, before.length, ...after);
    cursor = index + after.length;
  }
  return lines.join(eol) + (trailing && lines.length ? eol : "");
}

export function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("Binary files cannot be edited as text");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function applyPatch(client: Client, text: string, path: (value: string) => string, observations?: {
  check(path: string, bytes?: Buffer): Promise<void>;
  record(path: string, bytes?: Buffer): Promise<void>;
}) {
  const changes: { path: string; target: string; bytes?: Buffer; before: string; binary?: boolean; type: "add" | "update" | "delete" | "move" }[] = [];
  const seen = new Set<string>();
  // Validate every file/hunk before the first mutation, including move destinations.
  for (const patch of parsePatch(text)) {
    const source = path(patch.path);
    const target = patch.move ? path(patch.move) : source;
    for (const name of new Set([source, target])) {
      if (seen.has(name)) throw new Error(`Duplicate patch path: ${name}`);
      seen.add(name);
    }
    if (patch.kind === "Add" || target !== source) {
      const check = await client.exec(["sh", "-c", 'test ! -e "$1" && test ! -L "$1"', "deltabox-patch", target]);
      if (check.exit_code !== 0) throw new Error(`Patch destination exists or cannot be checked: ${target}`);
    }
    let bytes: Buffer | undefined;
    let before = "";
    let binary = false;
    if (patch.kind === "Add") bytes = Buffer.from(patch.lines.join("\n") + (patch.lines.length ? "\n" : ""));
    else {
      const original = await client.read(source);
      await observations?.check(source, original);
      if (patch.kind === "Delete") {
        try { before = decodeText(original); } catch { binary = true; }
      } else before = decodeText(original);
      if (patch.kind === "Update") bytes = Buffer.from(applyHunks(before, patch.hunks));
    }
    changes.push({ path: source, target, bytes, before, binary, type: patch.kind === "Add" ? "add" : patch.kind === "Delete" ? "delete" : source !== target ? "move" : "update" });
  }
  for (const change of changes) {
    if (change.bytes !== undefined) {
      await client.write(change.target, change.bytes);
      await observations?.record(change.target, change.bytes);
    }
    if (change.bytes === undefined || change.path !== change.target) {
      const result = await client.exec(["rm", "--", change.path], undefined, "apply_patch");
      if (result.exit_code !== 0) throw new Error(result.stderr || `Could not remove ${change.path}`);
      await observations?.record(change.path);
    }
  }
  const files = changes.map((change) => {
    const diff = fileDiff(change.target, change.before, change.bytes?.toString("utf8") ?? "");
    return { filePath: change.path, relativePath: relative(path("."), change.target), type: change.type, patch: change.binary ? `Binary file deleted: ${change.path}` : diff.patch, additions: diff.additions, deletions: diff.deletions, ...(change.path !== change.target ? { movePath: change.target } : {}) };
  });
  return { title: `Patched ${changes.length} file(s)`, output: `Applied patch to ${changes.length} file(s).`, metadata: { files, diff: files.map((file) => file.patch).join("\n") } };
}
