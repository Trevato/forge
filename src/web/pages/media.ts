/**
 * GET /:owner/:name/media/:ref/*path — a file's bytes under a real media
 * type, so a browser can show them in `<img>`, `<video>`, `<audio>`,
 * `<object>` and `fetch()`. `/raw` is the text you would copy; this is the
 * picture, the song, the PDF.
 *
 * The type comes only from the allowlist in `render/kinds.ts`, confirmed by
 * the file's own first bytes; anything else is `application/octet-stream`.
 * Never HTML, never script, and the sandbox policy below means an SVG that
 * carries a `<script>` is drawn as a picture and never runs on this origin.
 *
 * Bytes stream from git, never buffered whole, with HTTP Range so a video
 * seeks and a PDF streams. Access is `/raw`'s: a repository you cannot see
 * answers the same 404 as one that is not there.
 */

import { PINNED_PUBLIC, mayShare } from "../../http/addressed.ts";
import { EDGE_VARY } from "../../http/edge_cache.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { blobStream, readerFor } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { holds } from "../../http/etag.ts";
import { parseRange } from "../../http/range.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { loadRepo, notFoundPage } from "../chrome.ts";
import { cachedMedia, keepMedia } from "./tree_cache.ts";
import { HEAD_BYTES, mediaType } from "../render/kinds.ts";

/** The policy every media answer leaves with. */
export const MEDIA_POLICY =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";

/**
 * The one type with its own policy: Chrome's built-in PDF viewer will not run
 * in a sandboxed document, so `application/pdf` (and nothing else) leaves
 * without `sandbox`. It is still `default-src 'none'`, `nosniff`, and never
 * HTML: the type is confirmed by the `%PDF-` bytes, so the viewer is all that
 * ever opens it.
 */
export const PDF_POLICY =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

/**
 * An HTML file is served as a page only under this: `sandbox` with no
 * `allow-*` token gives it an opaque origin and no script, form or popup;
 * `default-src 'none'` blocks everything not listed. Images and stylesheets
 * load only from `scope`, this repository's files at this ref, so a relative
 * `../../` reference that climbs out of the repository (to another repository
 * or any page of the forge) is refused by the browser, not fetched. Inline
 * styles load. `frame-ancestors 'self'` lets only the forge's own blob page
 * frame it.
 */
export const htmlPolicy = (scope: string): string =>
  `sandbox; default-src 'none'; img-src ${scope} data:; style-src 'unsafe-inline' ${scope}; frame-ancestors 'self'`;

/** At or under this, the pooled reader hands the body back without a spawn. */
const SMALL_BYTES = 1_000_000;

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `/media/:ref/:path`, the address a renderer points its element at. */
export const mediaHref = (base: string, ref: string, path: string): string =>
  `${base}/media/${encodeURIComponent(ref)}/${path}`;

/** The file saved under its own name, streamed at any size. */
export const downloadHref = (base: string, ref: string, path: string): string =>
  `${mediaHref(base, ref, path)}?download=1`;

export async function mediaBlob(ctx: Ctx): Promise<Response> {
  // Server-Timing: `session` as the router measured it, `git` the object
  // reads, `stream` the time to have a body to send (the stream opened). A phase
  // is named only when it ran: no `git` before a stat, no `stream` for a small
  // file, a 304 or a 416.
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const clock: Clock = {};
  try {
    return await mediaRead(ctx, clock);
  } finally {
    if (clock.git !== undefined) notePhase(ctx.request, "git", clock.git);
    if (clock.stream !== undefined) notePhase(ctx.request, "stream", clock.stream);
  }
}

/** Milliseconds per phase; a phase that never ran stays undefined. */
type Clock = { git?: number; stream?: number };

async function mediaRead(ctx: Ctx, clock: Clock): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  if (!isSafeRef(ref) || !isSafeTreePath(path)) return notFoundPage(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const reader = readerFor(dir);
  // At a full commit id a small file never changes: a repeat read spawns no git (#9505).
  // A held read names no `git` phase: it did not run.
  const pinned = /^[0-9a-f]{40}$/.test(ref);
  const held = pinned ? cachedMedia(repo.id, ref, path) : undefined;
  let at = performance.now();
  let oid: string;
  let size: number;
  if (held !== undefined) {
    oid = held.oid;
    size = held.body.length;
  } else {
    const stat = await reader.stat(`${ref}:${path}`).catch(() => undefined);
    clock.git = (clock.git ?? 0) + (performance.now() - at);
    if (stat === undefined || !stat.ok || stat.value.type !== "blob")
      return notFoundPage(ctx);
    ({ oid, size } = stat.value);
  }

  const download = ctx.url.searchParams.get("download") === "1";
  const etag = `"${oid}"`;
  const shared = mayShare(ctx.request, ctx.auth.user === undefined, repo, ref);
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "content-security-policy": MEDIA_POLICY,
    // Same-origin embedding (the blob page's `<object>`) and nothing else.
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "same-origin",
    "accept-ranges": "bytes",
    etag,
    // A full commit id names bytes that can never change; a branch does not.
    // Only an anonymous request's copy of a public repository's may be shared.
    "cache-control": shared
      ? PINNED_PUBLIC
      : FULL_OID.test(ref)
        ? "private, max-age=31536000, immutable"
        : "private, max-age=0",
    ...(shared ? { vary: EDGE_VARY } : {}),
  };
  if (download) headers["content-disposition"] = attachment(path);
  // The tag is the blob id `stat` already gave, so a revalidation reads no byte.
  if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });

  // A small file is read whole through the pool; a large one is sniffed from
  // its first bytes and streamed, so its size never becomes memory.
  let body: Uint8Array | undefined;
  let head: Uint8Array;
  if (held !== undefined) {
    body = held.body;
    head = body.subarray(0, HEAD_BYTES);
  } else if (size <= SMALL_BYTES) {
    at = performance.now();
    const object = await reader.object(oid).catch(() => undefined);
    clock.git = (clock.git ?? 0) + (performance.now() - at);
    if (object === undefined || !object.ok) return notFoundPage(ctx);
    body = object.value.body;
    head = body.subarray(0, HEAD_BYTES);
    if (pinned) keepMedia(repo.id, ref, path, { oid, body });
  } else {
    at = performance.now();
    const sniff = await blobStream(dir, oid, 0, HEAD_BYTES - 1, { signal: ctx.request.signal });
    if (sniff === "busy" || sniff === "gone") return busy();
    head = await new Response(sniff).bytes();
    clock.git = (clock.git ?? 0) + (performance.now() - at);
  }
  const type = download ? "application/octet-stream" : mediaType(path, head);
  headers["content-type"] = type;
  if (type === "application/pdf") headers["content-security-policy"] = PDF_POLICY;
  if (type.startsWith("text/html")) {
    const origin = publicOrigin(ctx.app.config.url, ctx.url.origin);
    headers["content-security-policy"] = htmlPolicy(
      `${origin}${mediaHref(`/${repo.ownerName}/${repo.name}`, ref, "")}`,
    );
  }

  // A Range past an If-Range that no longer holds gets the whole new file.
  const ifRange = ctx.request.headers.get("if-range");
  const range =
    ifRange === null || ifRange === etag
      ? parseRange(ctx.request.headers.get("range"), size)
      : null;
  if (range === "unsatisfiable") {
    headers["content-range"] = `bytes */${size}`;
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (range !== null) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  const status = range === null ? 200 : 206;
  if (size === 0) return new Response(null, { status, headers });
  // A streamed body goes out chunked (Bun does not keep a length on a large
  // stream); `Content-Range` still names the whole size, which is what a
  // seeking player reads.
  if (body === undefined) {
    at = performance.now();
    const stream = await blobStream(dir, oid, start, end, { signal: ctx.request.signal });
    clock.stream = performance.now() - at;
    if (stream === "busy" || stream === "gone") return busy();
    return new Response(stream, { status, headers });
  }
  headers["content-length"] = String(end + 1 - start);
  return new Response(body.subarray(start, end + 1), { status, headers });
}

/** Every media permit is held and the queue is full: come back shortly. */
function busy(): Response {
  return new Response("Busy streaming other files; try again shortly.\n", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5", "cache-control": "no-store" },
  });
}

/** Saved under its own name, quoted so no byte of it can end the header. */
function attachment(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
