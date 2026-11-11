import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/mcp",
  summary: "The forge as an MCP server (JSON-RPC 2.0); see docs/MCP.md",
  auth: true,
  role: "member",
  body: { jsonrpc: "string", id: "integer", method: "string", params: "object" },
};
