/**
 * The `## MCP tools` section of /llms.txt: one line per tool in the generated
 * index and `report`, `name: doc` (its `description` when it has no `doc`),
 * then `(admin)` and `(writes)` where they apply. The live list of every tool,
 * so no committed file has to be regenerated when a tool changes (#8304).
 * Built once at boot; a reader with an account gets all of it, a stranger the
 * token-free tools and one line for the rest, so /llms.txt varies by reader.
 */
import type { Tool } from "../http/mcp/shared.ts";
import { TOKEN_FREE_TOOLS } from "../core/mcp_card.ts";

/** What a line reads: `report` is not a `Tool`, having no `run`, but is listed. */
export type Listed = Pick<Tool, "name" | "description" | "doc" | "writes" | "adminOnly" | "needsAdminScope">;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function toolLine(t: Listed): string {
  const admin = t.adminOnly === true || t.needsAdminScope === true ? " (admin)" : "";
  const writes = t.writes ? " (writes)" : "";
  // The same list the MCP's anonymous gate reads (core/mcp_card.ts).
  const open = TOKEN_FREE_TOOLS.includes(t.name) ? " (no account)" : "";
  return `- ${t.name}: ${oneLine(t.doc ?? t.description)}${admin}${writes}${open}`;
}

export const toolsSection = (tools: readonly Listed[]): string[] => [
  "## MCP tools",
  "",
  ...tools.map(toolLine),
  "",
];

/**
 * What a stranger can call, in full, then one line for the rest: the tools an
 * account opens are counted, not listed, and the line says where the list is.
 */
export const anonymousToolsSection = (open: readonly Listed[], more: number, origin: string): string[] => [
  "## MCP tools",
  "",
  ...open.map((t) => toolLine(t)),
  `- ${more} more tools with an account: call tools/list on ${origin}/mcp once signed in, or read ${origin}/contract/openapi.json.`,
  "",
];

// The index is handed in at boot by the server rather than imported here:
// importing it from a page module closes an import cycle through the actions.
let toolCount = 0;
let open: readonly Listed[] = [];
let section: readonly string[] = [];
export const setMcpTools = (all: readonly Listed[], tokenFree: readonly Listed[] = []): void => {
  toolCount = all.length;
  open = tokenFree;
  section = toolsSection([...all, ...tokenFree]);
};
/** The signed-in reader's section is the whole index; a stranger's is folded. */
export const mcpToolsSection = (origin: string, signedIn: boolean): readonly string[] =>
  signedIn ? section : anonymousToolsSection(open, toolCount, origin);
