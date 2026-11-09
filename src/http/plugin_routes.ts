/**
 * `GET /plugins/opencode/forge.ts` (#10198): the OpenCode plugin, the bytes of
 * the repository's own `plugins/opencode/forge.ts`, so a user connects with
 * one curl. Read on the first request, never at import, so a tree without
 * `plugins/` still boots and answers 404 here; the ETag is the bytes' hash, and a matching
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

export function pluginRoutes(router: Router<Handler>): void {
  router.add("GET", "/plugins/opencode/forge.ts", opencodePlugin);
}
