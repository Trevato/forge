/**
 * `GET /plugins/opencode/forge.ts` (#10198): the OpenCode plugin, the bytes of
 * the repository's own `plugins/opencode/forge.ts`, so a user connects with
 * one curl. Read on the first request, never at import, so a tree without
 * `plugins/` still boots and answers 404 here; the ETag is the bytes' hash, and a matching
 * `If-None-Match` is a 304. The securityFloor is set on every response by the
 * server, as for any route. `plugins` is a reserved name (src/core/reserved.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { offeredPluginRepo } from "../core/mcp_card.ts";
import { claudeMarketplace } from "../core/plugin_install.ts";
import { publicOrigin } from "../core/public_origin.ts";
import { UPSTREAM_REPO } from "../core/upstream.ts";
import type { Handler } from "./context.ts";
import { holds, weakEtag } from "./etag.ts";
import type { Router } from "./router.ts";

const FILE = join(import.meta.dir, "../../plugins/opencode/forge.ts");

const COMMANDS = join(import.meta.dir, "../../plugins/claude-code/commands");

/** The command files of a directory; empty when it is missing (only ENOENT is quiet, anything else is a real fault). */
function commandsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return [];
  }
}

const headers = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "public, max-age=300",
};

/** The file's bytes and ETag, read once; null when this tree does not carry it. */
let served: { bytes: Buffer; etag: string } | null | undefined;
function plugin(): { bytes: Buffer; etag: string } | null {
  if (served !== undefined) return served;
  try {
    const bytes = readFileSync(FILE);
    served = { bytes, etag: weakEtag(bytes.toString("utf8")) };
  } catch {
    served = null;
  }
  return served;
}

export const opencodePlugin: Handler = (ctx) => {
  const kept = plugin();
  if (kept === null) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const { bytes, etag } = kept;
  return holds(ctx.request, etag)
    ? new Response(null, { status: 304, headers: { etag, "cache-control": headers["cache-control"] } })
    : new Response(ctx.request.method === "HEAD" ? null : bytes, { headers: { ...headers, etag } });
};

/**
 * The manifest handler. The commands are read once, when it is made; it is 404
 * when the tree carries none or no source repository is offered.
 */
export function marketplaceManifest(dir: string = COMMANDS, upstream: { repo: string | undefined } = { repo: UPSTREAM_REPO }): Handler {
  const files = commandsIn(dir);
  return (ctx) => {
    const repo = offeredPluginRepo(ctx.app.db, ctx.app.config.forgeRepo, upstream.repo);
    if (repo === undefined || files.length === 0) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    // The configured address, never the Host header: the response is publicly cacheable.
    const origin = publicOrigin(ctx.app.config.url, ctx.url.origin);
    const body = JSON.stringify(claudeMarketplace(origin, repo, files), null, 2) + "\n";
    return new Response(ctx.request.method === "HEAD" ? null : body, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  };
}

export function pluginRoutes(router: Router<Handler>): void {
  router.add("GET", "/plugins/claude-code/marketplace.json", marketplaceManifest());
  router.add("GET", "/plugins/opencode/forge.ts", opencodePlugin);
}
