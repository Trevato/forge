/**
 * GET /api/v1 — the API's front door. An agent that starts here with no
 * account learns what this forge is and where its OpenAPI, MCP, OAuth,
 * llms.txt and page manifest live. Public, no state, absolute URLs on the
 * request's own origin.
 */

import { mcpPointers } from "../core/mcp_card.ts";
import { running } from "../kernel/version.ts";
import type { Ctx } from "./context.ts";

export function apiRootBody(origin: string): Record<string, unknown> {
  const { version, commit } = running();
  const mcp = mcpPointers(origin);
  return {
    name: "forge",
    version,
    commit,
    openapi: `${origin}/contract/openapi.json`,
    mcp: mcp.url,
    oauth: mcp.oauth,
    llms: `${origin}/llms.txt`,
    here: `${origin}/api/v1/here`,
  };
}

export function apiRoot(ctx: Ctx): Response {
  return new Response(JSON.stringify(apiRootBody(ctx.url.origin)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}
