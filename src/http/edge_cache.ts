/**
 * Which signed-out pages a shared cache (the edge) may keep, and for how long
 * (docs/web.md). The answer is `public` only for a request that carries no
 * identity at all — no cookie, no Authorization, no edge-vouched login — on a
 * page that is the same bytes for every visitor. Everything else is
 * `no-cache`: revalidate, never share. `privateWhenSignedIn`
 * (`http/respond.ts`) is the second lock on the same door.
 *
 * There is no purge call: the edge's own API credentials are not the forge's
 * to hold, so staleness is bounded by the lifetime below instead.
 */

/** Seconds a shared cache serves the page without asking. */
export const EDGE_FRESH = 60;
/** Seconds past that it may serve the old copy while it refetches. */
export const EDGE_STALE = 300;

/** What a shared copy must be keyed on: a request with any of these is never served the anonymous copy. */
export const EDGE_VARY = "Cookie, Authorization, X-Plat-User, X-Plat-Edge-Token";

/** Whether `owner/name` is an existing public repository. */
export type IsPublicRepo = (owner: string, name: string) => boolean;

/**
 * The pages whose signed-out body is the same for everyone: home, explore,
 * and the front page of a repository that exists and is public. Any other
 * path, however it is shaped (`/apps/new`, `/settings/x`), is not shared.
 */
export function sharedPath(pathname: string, isPublicRepo: IsPublicRepo): boolean {
  if (pathname === "/" || pathname === "/explore") return true;
  const m = /^\/([^/]+)\/([^/]+)$/.exec(pathname);
  return m !== null && isPublicRepo(m[1]!, m[2]!);
}

/** The `Cache-Control` of a signed-out, flash-free 200 for `pathname`. */
export function sharedCache(request: Request, pathname: string, isPublicRepo: IsPublicRepo): string {
  const h = request.headers;
  const anonymous =
    !h.has("cookie") && !h.has("authorization") && !h.has("x-plat-user") && !h.has("x-plat-edge-token");
  return anonymous && sharedPath(pathname, isPublicRepo)
    ? `public, max-age=0, s-maxage=${EDGE_FRESH}, stale-while-revalidate=${EDGE_STALE}`
    : "no-cache";
}
