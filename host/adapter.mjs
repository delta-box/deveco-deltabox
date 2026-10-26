import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These sources import DevEco internals and must be compiled by the host build.
export function installAdapter(source, check = false, adapter = join(dirname(fileURLToPath(import.meta.url)), "adapter")) {
  const target = join(source, "packages/opencode/src/plugin/deltabox");
  const files = readdirSync(adapter).sort().map((name) => {
    const bytes = readFileSync(join(adapter, name));
    const destination = join(target, name);
    if (existsSync(destination) && !readFileSync(destination).equals(bytes)) {
      throw new Error(`Adapter source differs at ${destination}; use a separate clean checkout. No adapter files were changed.`);
    }
    return { name, bytes };
  });
  if (!files.some((file) => file.name === "language.ts")) throw new Error("Mounted language adapter source is missing");
  if (!check) {
    mkdirSync(target, { recursive: true });
    for (const file of files) copyFileSync(join(adapter, file.name), join(target, file.name));
  }
  return createHash("sha256").update(files.map((file) => file.name + ":" + createHash("sha256").update(file.bytes).digest("hex")).join("\n")).digest("hex");
}
