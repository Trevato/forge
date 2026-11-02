/**
 * The `## MCP tools` section of /llms.txt: one line per tool in the generated
 * index, `name: description`, then `(admin)` and `(writes)` where they apply.
 * Built once at boot and the same for every reader, whoever they are.
 */
import type { Tool } from "../http/mcp/shared.ts";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function toolLine(t: Tool): string {
  const admin = t.adminOnly === true || t.needsAdminScope === true ? " (admin)" : "";
  const writes = t.writes ? " (writes)" : "";
  return `- ${t.name}: ${oneLine(t.description)}${admin}${writes}`;
}

export const toolsSection = (tools: readonly Tool[]): string[] => [
  "## MCP tools",
  "",
  ...tools.map(toolLine),
  "",
];

// The index is handed in at boot by the server rather than imported here:
// importing it from a page module closes an import cycle through the actions.
let section: readonly string[] = [];
export const setMcpTools = (tools: readonly Tool[]): void => {
  section = toolsSection(tools);
};
export const mcpToolsSection = (): readonly string[] => section;
