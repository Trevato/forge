/**
 * Where the MCP server is, in one place: the `mcp` block of
 * `/api/v1/here` and the card at `/.well-known/mcp.json` both read it, so
 * they cannot drift.
 *
 * The MCP server-card format is still a draft, so the card may not match a
 * later standard's field names; when one settles, the card follows it.
 */
import { running, type Running } from "../kernel/version.ts";

/** The endpoint and the protected-resource metadata that names how to sign in. */
export function mcpPointers(origin: string): { url: string; oauth: string } {
  return {
    url: `${origin}/mcp`,
    oauth: `${origin}/.well-known/oauth-protected-resource`,
  };
}

/**
 * The server card. The format is still a draft, so only what we can keep
 * true is named: who answers, where, over what transport, how to sign in,
 * and the one tool that needs no token.
 */
export function mcpCard(origin: string, now: Running = running()) {
  const { url, oauth } = mcpPointers(origin);
  return {
    name: "forge",
    version: now.version,
    commit: now.commit,
    endpoint: url,
    transport: "streamable-http",
    protectedResourceMetadata: oauth,
    documentation: `${origin}/llms.txt`,
    tokenFreeTools: ["report"],
  };
}
