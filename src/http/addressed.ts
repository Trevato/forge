/**
 * Commit-addressed pages are immutable (#8129, #8016): a blob or a commit at
 * a full object id names bytes that can never change, so for an anonymous
 * reader of a public repository the page may sit in a shared cache for a
 * while. Only the anonymous render qualifies: the caller says, from the
 * resolved auth (a cookie, a token or the edge's signed headers alike), that
 * no one is behind the request; anyone else gets a page with their topbar,
 * which `privateWhenSignedIn` keeps private. `Vary` makes a cache keep the two
 * apart. The browser keeps it a year (the bytes cannot change), but a shared
 * cache only a day (`s-maxage`): a repository can later turn private or be
 * deleted, and a shared cache must not go on serving it for long.
 */

/** How long a shared cache may keep an addressed page, seconds. */
export const SHARED_MAX_AGE_S = 86_400;

const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `rev` is a full object id and not a branch, tag or abbreviation. */
export const isFullId = (rev: string): boolean => FULL_ID.test(rev);

export function immutableWhenAddressed(
  anonymous: boolean,
  repo: { readonly visibility: string },
  rev: string,
  response: Response,
): Response {
  if (response.status !== 200 || repo.visibility !== "public" || !isFullId(rev)) return response;
  if (!anonymous) return response;
  response.headers.set("cache-control", `public, max-age=31536000, s-maxage=${SHARED_MAX_AGE_S}, immutable`);
  response.headers.append("vary", "Cookie, Authorization");
  return response;
}
