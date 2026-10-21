import type { Plugin } from "@opencode-ai/plugin";
import { createPlugin } from "./integration.js";

// Export exactly one plugin function: legacy hosts initialize every exported function.
const plugin: Plugin = (input) => createPlugin(input);
export default plugin;
