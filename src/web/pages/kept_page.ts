/**
 * A stranger's finished code page, encoded and kept (#9514).
 *
 * `tree_cache.ts` keeps the markup of a page's two columns, but a hit still
 * built the chrome around them, joined ~150 KB of HTML and brotli'd it: about
 * 4 ms of the one main thread a page. And those columns are big enough that
 * 32 MB holds ~220 pages, so a crawl across a whole repository missed most of
 * the time and rendered again. Encoded, a page is ~15 KB: this keeps the bytes
 * that went out, so the next stranger asking the same URL is answered with
 * no rendering and no encoding at all, and thousands of pages fit.
 *
 * It is the copy the edge keeps (`http/addressed.ts`), held in-process: the
 * same bytes for every reader with no identity, for `TTL_MS` (a minute, the
 * staleness the kept columns already allow their ref switcher). Unlike the
 * edge's, it is read only after the route has loaded the repository and
 * checked it may be read, so a repository turned private stops being served
 * at once. The key names everything the page is built from on a stranger's
 * request: the URL, the sign-in link (an edge token changes it), which
 * identity headers came (they change Cache-Control and Vary), the encoding,
 * and what the caller adds (the commit a branch named). A request that could
 * see a different page never shares a key: a theme or flash cookie, a
 * signed-in reader, a conditional or ranged GET, anything but GET.
 */

import { encodeRecent, negotiate, type Encoding } from "../../http/compress.ts";
import type { Ctx } from "../../http/context.ts";
import { ViewCache } from "../../view/cache.ts";
import { readFlash } from "../flash.ts";
import { signInHref } from "../layout.ts";

interface KeptPage {
  readonly body: Uint8Array;
  readonly headers: readonly [string, string][];
}

/** A minute: `tree_cache.ts`'s `TTL_MS`, named here so neither module imports the other. */
const TTL_MS = 60_000;

/** Bytes the kept pages may hold, shown on /system. */
export const KEPT_PAGE_BYTES = 64 * 1024 * 1024;
const store = new ViewCache({ maxEntries: 8192, maxBytes: KEPT_PAGE_BYTES });

/**
 * The only headers a kept page carries to the next reader: what the page *is*
 * (type, policy, caching, validators, preloads). Everything else on the first
 * answer belongs to that one response (a request id, timing, a date, a cookie,
 * anything a later layer adds) and is never frozen and handed on; the layers
 * after the route (`server-timing`, the security floor) set theirs again on
 * every answer. The page's policy names its inline styles by hash, not a
 * nonce (`layout.ts`), so replaying it with the same body is exact.
 */
export const KEPT_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-security-policy",
  "cache-control",
  "vary",
  "etag",
  "last-modified",
  "link",
  "speculation-rules",
  "referrer-policy",
  "x-content-type-options",
]);

/** Headers that change what a stranger's page is, by presence. */
const IDENTITY = ["cookie", "authorization", "x-plat-user", "x-plat-edge-token"] as const;

/** The key this request's page is kept under, or undefined when it may not share one. */
export function keptPageKey(ctx: Ctx, repoId: string, ...parts: string[]): string | undefined {
  const r = ctx.request;
  if (ctx.auth.user !== undefined || r.method !== "GET" || ctx.theme !== undefined) return undefined;
  if (r.headers.has("if-none-match") || r.headers.has("range") || readFlash(r) !== undefined) return undefined;
  const encoding = negotiate(r.headers.get("accept-encoding"));
  if (encoding === null) return undefined;
  const identity = IDENTITY.map((name) => (r.headers.has(name) ? "1" : "0")).join("");
  return [encoding, identity, repoId, ...parts, signInHref(ctx), ctx.url.origin, ctx.url.pathname, ctx.url.search].join("\0");
}

const encodingOf = (key: string): Encoding => key.slice(0, key.indexOf("\0")) as Encoding;

/** The kept page for `key`, as a fresh Response; undefined on a miss. */
export function keptPage(key: string): Response | undefined {
  const hit = store.get<KeptPage>(key);
  if (hit === undefined) return undefined;
  return new Response(hit.body, { status: 200, headers: new Headers([...hit.headers]) });
}

/** Keep `response`'s bytes, encoded, under `key`, and answer with them. Anything but a plain 200 goes out as it came. */
export async function keepPage(key: string, response: Response): Promise<Response> {
  if (response.status !== 200 || response.headers.getSetCookie().length > 0 || response.headers.has("content-encoding")) return response;
  const encoding = encodingOf(key);
  const body = encodeRecent(new Uint8Array(await response.arrayBuffer()), encoding);
  const headers: [string, string][] = [...response.headers].filter(([name]) => KEPT_HEADERS.has(name));
  headers.push(["content-encoding", encoding]);
  store.set(key, { body, headers }, TTL_MS, body.length + 1024);
  return new Response(body, { status: 200, headers: new Headers(headers) });
}

export const keptPageStats = () => store.stats();

/** Test seam: start from nothing. */
export const clearKeptPages = (): void => store.clear();
