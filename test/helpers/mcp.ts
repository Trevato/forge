import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// One MCP tools/call over HTTP, answered as { value } or { error }.
export const mcpTool = async (
  base: string,
  token: string,
  name: string,
  args: unknown = {},
): Promise<{ value?: any; error?: string }> => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

/**
 * The MCP door's source as one text: `src/http/mcp.ts` and every file under
 * `src/http/mcp/` (one per tool since #5924), for tests that read the door.
 */
export function mcpSource(root: string): string {
  const files = ["src/http/mcp.ts", ...readdirSync(join(root, "src/http/mcp"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join("src/http/mcp", f))];
  return files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
}

/** Whether `text` imports `module` (`actions/x.ts`) from any depth under src/. */
export const importsFrom = (text: string, module: string): boolean =>
  new RegExp(`from "(\\.\\./)+${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(text);
