import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const filesystem = z.object({
  mode: z.enum(["auto", "cbcow-through", "cbcow-private", "copy-private"]).default("auto"),
  require: z.boolean().default(false),
  durability: z.enum(["fast", "strict"]).default("fast"),
  groupCommitMs: z.number().int().positive().nullable().default(null),
}).strict();
const review = z.object({ mode: z.enum(["task", "tool", "risky"]).default("task") }).strict();
const schema = z.object({
  transport: z.enum(["native", "serve", "cli"]).default("native"),
  bin: z.string().min(1).default("deltabox"),
  nativeAddon: z.string().min(1).nullable().default(null),
  policy: z.string().min(1).nullable().default(null),
  stateDir: z.string().min(1).nullable().default(null),
  runtimeDir: z.string().min(1).nullable().default(null),
  trusted: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(660_000),
  filesystem: filesystem.default(() => filesystem.parse({})),
  review: review.default(() => review.parse({})),
}).strict();

export type Config = ReturnType<typeof schema.parse>;
export type ReviewMode = Config["review"]["mode"];

export function parseConfig(raw: unknown): Config {
  return schema.parse(raw);
}

function canonicalStatePath(path: string): string {
  const suffix: string[] = [];
  for (let existing = path; ; existing = dirname(existing)) {
    try { return join(realpathSync(existing), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      suffix.unshift(basename(existing));
    }
  }
}

/** Invalid policy/configuration is an error, never a silent fallback to defaults. */
export function loadConfig(project: string, userFile = process.env.DEVECO_DELTABOX_CONFIG || join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "deveco", "deltabox.json",
)): Config {
  let result = parseConfig({});
  for (const file of [userFile, join(project, "deltabox.json")]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const raw = JSON.parse(text);
    // Validate the layer before merging; nulls/arrays must not erase defaults.
    const layer = schema.partial().parse(raw);
    result = parseConfig({
      ...result, ...layer,
      filesystem: { ...result.filesystem, ...raw.filesystem },
      review: { ...result.review, ...raw.review },
    });
  }
  for (const key of ["policy", "nativeAddon", "stateDir", "runtimeDir"] as const) {
    if (result[key]) result[key] = resolve(project, result[key]);
  }
  // FSEvents reports canonical paths. In particular /var and /tmp are aliases
  // on macOS; private state under those aliases must use the same spelling.
  for (const key of ["stateDir", "runtimeDir"] as const) {
    if (result[key]) result[key] = canonicalStatePath(result[key]);
  }
  if (/[\\/]/.test(result.bin)) result.bin = resolve(project, result.bin);
  return result;
}
