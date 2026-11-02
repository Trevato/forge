/**
 * Where the MCP server is, in one place: the `mcp` block of
 * `/api/v1/here` and the card at `/.well-known/mcp.json` both read it, so
 * they cannot drift.
 *
 * The MCP server-card format is still a draft, so the card may not match a
 * later standard's field names; when one settles, the card follows it.
 */
import type { Database } from "bun:sqlite";
import { getRepo } from "./repos.ts";
import { running, type Running } from "../kernel/version.ts";

/** The endpoint and the protected-resource metadata that names how to sign in. */
export function mcpPointers(origin: string): { url: string; oauth: string } {
  return {
    url: `${origin}/mcp`,
    oauth: `${origin}/.well-known/oauth-protected-resource`,
  };
}

/**
 * The MCP tools a stranger may call with no token: the gate in
 * `http/mcp.ts` answers these and refuses the rest with 401. The card and
 * `/api/v1/here` both read this list, so they cannot drift.
 */
export const TOKEN_FREE_TOOLS: readonly string[] = ["report"];

/** A thin plugin the forge ships for a harness: where its source is and its one install line. */
export interface HarnessPlugin {
  readonly harness: string;
  readonly label: string;
  readonly path: string;
  /** The one line, given the origin it was read from; it works in an empty directory. */
  readonly install: (origin: string) => string;
  /** What to set before it runs. */
  readonly setup: string;
}

/** The repository that holds the plugins; the lines are offered only while it is public on this forge. */
const PLUGIN_REPO = "trevato/forge";

/** Whether the plugin source can be read without a token here, so every printed install line works. */
export function pluginsOffered(db: Database): boolean {
  const [owner = "", name = ""] = PLUGIN_REPO.split("/");
  return getRepo(db, owner, name)?.visibility === "public";
}

/** The clone URL of that repository on this forge's origin. */
export function pluginSource(origin: string): string {
  return `${origin}/${PLUGIN_REPO}.git`;
}

/** The one list the card and /llms.txt both read, so they cannot drift. */
export const HARNESS_PLUGINS: readonly HarnessPlugin[] = [
  {
    harness: "claude-code",
    label: "Claude Code",
    path: "plugins/claude-code",
    install: (o) =>
      `git clone --depth 1 --filter=blob:none --sparse ${pluginSource(o)} forge-plugin && git -C forge-plugin sparse-checkout set plugins/claude-code && claude --plugin-dir forge-plugin/plugins/claude-code`,
    setup: "set FORGE_URL, then sign in through /mcp with the forge server; or also set FORGE_TOKEN and use the forge-token server",
  },
  {
    harness: "opencode",
    label: "OpenCode",
    path: "plugins/opencode/forge.ts",
    install: (o) =>
      `mkdir -p .opencode/plugin && curl -fsSL ${o}/${PLUGIN_REPO}/raw/main/plugins/opencode/forge.ts -o .opencode/plugin/forge.ts`,
    setup: "set FORGE_URL and FORGE_TOKEN",
  },
];

/**
 * The server card. The format is still a draft, so only what we can keep
 * true is named: who answers, where, over what transport, how to sign in,
 * and the one tool that needs no token.
 */
export function mcpCard(origin: string, offered: boolean, now: Running = running()) {
  const { url, oauth } = mcpPointers(origin);
  return {
    name: "forge",
    version: now.version,
    commit: now.commit,
    endpoint: url,
    transport: "streamable-http",
    protectedResourceMetadata: oauth,
    documentation: `${origin}/llms.txt`,
    openapi: `${origin}/contract/openapi.json`,
    tokenFreeTools: [...TOKEN_FREE_TOOLS],
    plugins: (offered ? HARNESS_PLUGINS : []).map((p) => ({
      harness: p.harness,
      path: p.path,
      source: pluginSource(origin),
      install: p.install(origin),
    })),
  };
}
