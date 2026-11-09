/**
 * Where the MCP server is, in one place: the `mcp` block of
 * `/api/v1/here` and the card at `/.well-known/mcp.json` both read it, so
 * they cannot drift.
 *
 * The MCP server-card format is still a draft, so the card may not match a
 * later standard's field names; when one settles, the card follows it.
 */
import type { Database } from "bun:sqlite";
import { running, type Running } from "../kernel/version.ts";
import { forgeSource } from "../settings/forge_source.ts";
import { repoVisibility } from "./repos.ts";

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
  /** The one line, given the origin it was read from and the source repository; it works in an empty directory. */
  readonly install: (origin: string, repo: string) => string;
  /** What to set before it runs. */
  readonly setup: string;
}

/**
 * The repository that holds the plugins, as `owner/name`: the forge's
 * configured source (admin setting, else `FORGE_REPO`), and only while it is
 * public here, so every printed line works for whoever reads it. The card,
 * /llms.txt, Settings › Tokens and the terminal all ask this one question.
 */
export function offeredPluginRepo(db: Database, fromEnv: string | undefined): string | undefined {
  const repo = forgeSource(db, fromEnv);
  if (repo === undefined) return undefined;
  const [owner = "", name = ""] = repo.split("/");
  return repoVisibility(db, owner, name) === "public" ? repo : undefined;
}

/** The two Claude Code lines that install the plugin from the marketplace. */
export function marketplaceLines(origin: string, repo: string): { add: string; install: string } {
  return { add: `/plugin marketplace add ${pluginSource(origin, repo)}`, install: "/plugin install forge@forge" };
}

/** The clone URL of that repository on this forge's origin. */
export function pluginSource(origin: string, repo: string): string {
  return `${origin}/${repo}.git`;
}

/** The one list the card and /llms.txt both read, so they cannot drift. */
export const HARNESS_PLUGINS: readonly HarnessPlugin[] = [
  {
    harness: "claude-code",
    label: "Claude Code",
    path: "plugins/claude-code",
    install: (o, r) =>
      `git clone --depth 1 --filter=blob:none --sparse ${pluginSource(o, r)} forge-plugin && git -C forge-plugin sparse-checkout set plugins/claude-code && claude --plugin-dir forge-plugin/plugins/claude-code`,
    setup: "set FORGE_URL, then sign in through /mcp with the forge server; or also set FORGE_TOKEN and use the forge-token server",
  },
  {
    harness: "opencode",
    label: "OpenCode",
    path: "plugins/opencode/forge.ts",
    install: (o, r) =>
      `mkdir -p .opencode/plugin && curl -fsSL ${o}/${r}/raw/main/plugins/opencode/forge.ts -o .opencode/plugin/forge.ts`,
    setup: "set FORGE_URL and FORGE_TOKEN",
  },
];

/**
 * The server card. The format is still a draft, so only what we can keep
 * true is named: who answers, where, over what transport, how to sign in,
 * and the one tool that needs no token.
 */
export function mcpCard(origin: string, repo: string | undefined, now: Running = running()) {
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
    plugins: (repo === undefined ? [] : HARNESS_PLUGINS).map((p) => ({
      harness: p.harness,
      path: p.path,
      source: pluginSource(origin, repo!),
      install: p.install(origin, repo!),
    })),
  };
}
