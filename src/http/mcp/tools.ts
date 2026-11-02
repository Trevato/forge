/**
 * Every MCP tool but `report`, by name: one file each under `tools/`,
 * gathered by the generated `tools/index.ts` (`bun scripts/mcp-tools.ts`).
 * A new tool is a new file there, so pulls adding tools do not collide (#5924).
 */
import { byName, type Tool } from "./shared.ts";
import * as each from "./tools/index.ts";

export const TOOLS: readonly Tool[] = Object.values(each).sort(byName);
