import { bad, good, str, type Tool } from "../shared.ts";
import { FIND_MAX, matching, QUERY_MAX } from "../catalog.ts";

export const tool: Tool = {
  name: "find_tool",
  doc: "`{ query }`: the tools whose name or description match every word, with their one-line description and schema; a tool found is callable at once, listed or not. `tools/list` with `{\"all\": true}` is the full list",
  description: "Find a tool by what it does; returns name, description and schema. Any tool is callable by name.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", maxLength: QUERY_MAX } },
    required: ["query"],
  },
  writes: false,
  async run(ctx, user, args) {
    const query = str(args["query"]).trim();
    if (query === "") return bad("invalid_query", "query is a word or two about what you want to do");
    // Lazy: mcp.ts imports the tool table, which holds this tool.
    const { entriesFor } = await import("../../mcp.ts");
    const found = matching(
      entriesFor(ctx, user).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      query,
    );
    return good({
      tools: found.slice(0, FIND_MAX),
      ...(found.length > FIND_MAX ? { more: found.length - FIND_MAX } : {}),
    });
  },
};
