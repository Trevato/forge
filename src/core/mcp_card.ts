/**
 * Where the MCP server is, in one place: the `mcp` block of
 * `/api/v1/here` and the card at `/.well-known/mcp.json` both read it, so
 * they cannot drift.
 *
 * The MCP server-card format is still a draft, so the card may not match a
 * later standard's field names; when one settles, the card follows it.
 */
import type { Database } from "bun:sqlite";
import { claudeInstall, opencodeInstall, pluginSource } from "./plugin_install.ts";
import { running, type Running } from "../kernel/version.ts";
import { forgeSource } from "../settings/forge_source.ts";
import { repoVisibility } from "./repos.ts";

/** The endpoint and the protected-resource metadata that names how to sign in. */
export function mcpPointers(origin: string): { url: string; oauth: string } {
  return {
    url: `${origin}${DISCOVERY.mcp}`,
    oauth: `${origin}/.well-known/oauth-protected-resource`,
  };
}

/** The paths the discovery documents name each other by; the card, the API catalog and /llms.txt read them, so they cannot drift. */
export const DISCOVERY = {
  openapi: "/contract/openapi.json",
  docs: "/llms.txt",
  card: "/.well-known/mcp.json",
  catalog: "/.well-known/api-catalog",
  mcp: "/mcp",
  api: "/api/v1",
} as const;

/** The `Link` header value that points at the catalog (RFC 9727 §3). */
export const API_CATALOG_LINK = `<${DISCOVERY.catalog}>; rel="api-catalog"`;

/** RFC 9727 API catalog: an RFC 9264 linkset, one anchor per API. */
export function apiCatalog(origin: string) {
  return {
    linkset: [
      {
        anchor: `${origin}${DISCOVERY.api}`,
        "service-desc": [{ href: `${origin}${DISCOVERY.openapi}`, type: "application/json" }],
        "service-doc": [{ href: `${origin}${DISCOVERY.docs}`, type: "text/plain" }],
      },
      {
        anchor: mcpPointers(origin).url,
        "service-desc": [{ href: `${origin}${DISCOVERY.card}`, type: "application/json" }],
        "service-doc": [{ href: `${origin}${DISCOVERY.docs}`, type: "text/plain" }],
      },
    ],
  };
}

/**
 * The MCP tools a stranger may call with no token: the gate in
 * `http/mcp.ts` answers these and refuses the rest with 401. The card and
 * `/api/v1/here` both read this list, so they cannot drift.
 */
export const TOKEN_FREE_TOOLS: readonly string[] = ["report", "start"];

/** A thin plugin the forge ships for a harness: where its source is and its one install line. */
export interface HarnessPlugin {
  readonly harness: string;
  readonly label: string;
  readonly path: string;
  /** True when the install clones the source repository (so it needs one offered); false when this forge serves the file itself. */
  readonly cloned: boolean;
  /** The one line, given the origin it was read from and the source repository; it works in an empty directory. */
  readonly install: (origin: string, repo: string) => string;
  /** What to set before it runs. */
  readonly setup: string;
}

/**
 * The repository that holds the plugins, as `owner/name`, or the upstream's
 * full URL: the forge's own source (admin setting, else `FORGE_REPO`) while it
 * is public here, else `upstream`, so every printed line works for whoever
 * reads it. Undefined only when neither is available. The card, /llms.txt,
 * Settings › Tokens and the terminal all ask this one question.
 */
export function offeredPluginRepo(db: Database, fromEnv: string | undefined, upstream: string | undefined): string | undefined {
  const repo = forgeSource(db, fromEnv);
  if (repo !== undefined) {
    const [owner = "", name = ""] = repo.split("/");
    if (repoVisibility(db, owner, name) === "public") return repo;
  }
  return upstream;
}

export { pluginSource };

/** The one list the card and /llms.txt both read, so they cannot drift. */
export const HARNESS_PLUGINS: readonly HarnessPlugin[] = [
  {
    harness: "claude-code",
    label: "Claude Code",
    path: "plugins/claude-code",
    cloned: true,
    install: (o) => claudeInstall(o),
    setup: "set FORGE_URL, then sign in through /mcp with the forge server; or also set FORGE_TOKEN and use the forge-token server",
  },
  {
    harness: "opencode",
    label: "OpenCode",
    path: "plugins/opencode/forge.ts",
    cloned: false,
    install: (o) => opencodeInstall(o),
    setup: "set FORGE_URL and FORGE_TOKEN",
  },
];

/** The plugins this forge can offer: the ones it serves itself always, the cloned ones only while a public source exists. */
export function offeredPlugins(repo: string | undefined): readonly HarnessPlugin[] {
  return HARNESS_PLUGINS.filter((p) => !p.cloned || repo !== undefined);
}

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
    documentation: `${origin}${DISCOVERY.docs}`,
    openapi: `${origin}${DISCOVERY.openapi}`,
    tokenFreeTools: [...TOKEN_FREE_TOOLS],
    plugins: offeredPlugins(repo).map((p) => ({
      harness: p.harness,
      path: p.path,
      ...(repo !== undefined ? { source: pluginSource(origin, repo) } : {}),
      install: p.install(origin, repo ?? ""),
    })),
  };
}
