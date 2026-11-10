/**
 * The read-only standby's one guard (#9657). A forge started with
 * `FORGE_READ_ONLY=1` answers reads and refuses everything that could
 * change state, at the front of the request path: one check on the method,
 * not a check per route, so a route added next year is covered.
 *
 * Allowed: GET, HEAD and OPTIONS (a WebSocket upgrade is a GET and is
 * refused, since a shell is a write), and the one POST that only reads,
 * git's `git-upload-pack` (clone and fetch). The push advertisement
 * (`info/refs?service=git-receive-pack`) is refused too, so a client is
 * told before it sends a pack.
 */

import { MAINTENANCE_HEADERS } from "../maintenance/page.ts";

/** True when the environment asks for a read-only standby (`FORGE_READ_ONLY=1`). */
export const readOnlyFrom = (env: Record<string, string | undefined>): boolean =>
  (env["FORGE_READ_ONLY"] ?? "").trim() === "1";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const UPLOAD_PACK = /^\/[^/]+\/[^/]+\.git\/git-upload-pack$/;

/** Whether a request only reads: by method and path, nothing else. */
export function isRead(request: Request): boolean {
  const url = new URL(request.url);
  if (request.method === "POST" && UPLOAD_PACK.test(url.pathname)) return true;
  if (!READS.has(request.method)) return false;
  if (request.headers.get("upgrade") !== null) return false;
  return url.searchParams.get("service") !== "git-receive-pack";
}

const WORDS = "read-only standby";

/** The plain 503 a mutation gets on a standby; undefined for a read. */
export function readOnlyRefusal(request: Request): Response | undefined {
  if (isRead(request)) return undefined;
  const wantsJson =
    new URL(request.url).pathname.startsWith("/api/") ||
    (request.headers.get("accept") ?? "").includes("application/json");
  const headers = { ...MAINTENANCE_HEADERS };
  if (wantsJson) {
    headers["content-type"] = "application/json; charset=utf-8";
    return new Response(JSON.stringify({ error: "read_only", message: WORDS, retryAfter: Number(MAINTENANCE_HEADERS["retry-after"]) }), { status: 503, headers });
  }
  headers["content-type"] = "text/plain; charset=utf-8";
  return new Response(`${WORDS}: this forge is serving reads while the main one is away; nothing can be changed here.\n`, {
    status: 503,
    headers,
  });
}
