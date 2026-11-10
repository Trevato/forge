/** Rewrite the tool table in docs/MCP.md from the live definitions. */
import { renderTable, withTable } from "../src/http/mcp_table.ts";

const path = new URL("../docs/MCP.md", import.meta.url);
const doc = await Bun.file(path).text();
await Bun.write(path, withTable(doc, renderTable()));
