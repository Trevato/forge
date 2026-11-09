/**
 * `GET /plugins/opencode/forge.ts` (#10198): the OpenCode plugin, the bytes of
 * the repository's own `plugins/opencode/forge.ts`, so a user connects with
 * one curl. Read once at boot; the ETag is the bytes' hash, and a matching
 * `If-None-Match` is a 304. The securityFloor is set on every response by the
 * server, as for any route. `plugins` is a reserved name (src/core/reserved.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "./context.ts";
import { holds, weakEtag } from "./etag.ts";
import type { Router } from "./router.ts";

const FILE = join(import.meta.dir, "../../plugins/opencode/forge.ts");

/** The one-line install: the forge's own origin, no trailing slash. */
export function opencodeInstall(origin: string): string {
  return `mkdir -p .opencode/plugin && curl -fsSo .opencode/plugin/forge.ts ${origin.replace(/\/+$/, "")}/plugins/opencode/forge.ts`;
}

const bytes = readFileSync(FILE);
const etag = weakEtag(bytes.toString("utf8"));
const headers = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "public, max-age=300",
  etag,
};

export const opencodePlugin: Handler = (ctx) =>
  holds(ctx.request, etag)
    ? new Response(null, { status: 304, headers: { etag, "cache-control": headers["cache-control"] } })
    : new Response(ctx.request.method === "HEAD" ? null : bytes, { headers });

export function pluginRoutes(router: Router<Handler>): void {
  router.add("GET", "/plugins/opencode/forge.ts", opencodePlugin);
}
