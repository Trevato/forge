/**
 * The `## MCP tools` section of /llms.txt: one line per tool in the generated
 * index and `report`, `name: doc` (its `description` when it has no `doc`),
 * then `(admin)` and `(writes)` where they apply. The live list of every tool,
 * so no committed file has to be regenerated when a tool changes (#8304).
 * Built once at boot and the same for every reader, whoever they are.
 */
import type { Tool } from "../http/mcp/shared.ts";

/** What a line reads: `report` is not a `Tool`, having no `run`, but is listed. */
export type Listed = Pick<Tool, "name" | "description" | "doc" | "writes" | "adminOnly" | "needsAdminScope">;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function toolLine(t: Listed): string {
  const admin = t.adminOnly === true || t.needsAdminScope === true ? " (admin)" : "";
  const writes = t.writes ? " (writes)" : "";
  return `- ${t.name}: ${oneLine(t.doc ?? t.description)}${admin}${writes}`;
}

export const toolsSection = (tools: readonly Listed[]): string[] => [
  "## MCP tools",
  "",
  ...tools.map(toolLine),
  "",
];

// The index is handed in at boot by the server rather than imported here:
// importing it from a page module closes an import cycle through the actions.
let section: readonly string[] = [];
export const setMcpTools = (tools: readonly Listed[]): void => {
  section = toolsSection(tools);
};
export const mcpToolsSection = (): readonly string[] => section;
