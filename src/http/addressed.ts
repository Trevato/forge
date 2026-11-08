/**
 * Commit-addressed pages are immutable (#8129, #8016): a blob or a commit at
 * a full object id names bytes that can never change, so for an anonymous
 * reader of a public repository the page may sit in a shared cache for a
 * while. Only the anonymous render qualifies: the caller says, from the
 * resolved auth (a cookie, a token or the edge's signed headers alike), that
 * no one is behind the request, and the request must carry nothing a page can
 * depend on: a theme or flash cookie changes the HTML, and `privateWhenSignedIn`
 * lets anything `immutable` through, so this is the only lock. `Vary` keeps the
 * copies apart in a cache that honors it; Cloudflare's doesn't, for HTML, so a
 * rule there must bypass any request with a Cookie or Authorization header.
 * The browser keeps it a year (the bytes cannot change), but a shared
 * cache only a day (`s-maxage`): a repository can later turn private or be
 * deleted, and a shared cache must not go on serving it for long.
 */

import { EDGE_VARY } from "./edge_cache.ts";

/** How long a shared cache may keep an addressed page, seconds. */
export const SHARED_MAX_AGE_S = 86_400;

const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `rev` is a full object id and not a branch, tag or abbreviation. */
export const isFullId = (rev: string): boolean => FULL_ID.test(rev);

/** The header a pinned page may go out with. */
export const PINNED_PUBLIC = `public, max-age=31536000, s-maxage=${SHARED_MAX_AGE_S}, immutable`;

/** Whether the answer at this full id may sit in a shared cache: a public repository, and no identity or cookie on the request. */
export function mayShare(request: Request, anonymous: boolean, repo: { readonly visibility: string }, rev: string): boolean {
  if (!anonymous || repo.visibility !== "public" || !isFullId(rev)) return false;
  const h = request.headers;
  // The edge's own token comes on every request it carries, a visitor's too; only a named user changes the page.
  return !h.has("cookie") && !h.has("authorization") && !h.has("x-plat-user");
}

export function immutableWhenAddressed(
  request: Request,
  anonymous: boolean,
  repo: { readonly visibility: string },
  rev: string,
  response: Response,
): Response {
  if (response.status !== 200 || response.headers.has("set-cookie") || !mayShare(request, anonymous, repo, rev)) return response;
  response.headers.set("cache-control", PINNED_PUBLIC);
  response.headers.set("vary", EDGE_VARY);
  return response;
}
