import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";

/** Versioned additions supplied by host/deveco-code.patch. */
export type HostInput = PluginInput & {
  experimental_capabilities?: { sessionStopping?: number; commandResult?: number; shellEnv?: number };
};
export type HostContext = ToolContext & {
  shellEnv?(cwd: string): Promise<Record<string, string>>;
};
export type HostHooks = Hooks & {
  "session.turn.stopping"?: (context: ToolContext, output: Record<string, never>) => Promise<void>;
};
export type CommandOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1] & {
  result?: { text: string };
};
