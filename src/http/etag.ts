/**
 * A signed-out page that has not changed costs a header, not a body
 * (specification.website/#caching). The ETag is weak and computed from the
 * body's bytes; a request holding it is answered 304 with the page's own
 * headers.
 *
 * A page carries no nonce (its scripts are hashed files, its inline styles
 * are named by hash), so the same bytes are the same page and a 304 renews
 * nothing the cached body disagrees with. Signed-in pages, any that show a
 * flash, and any that are not 200 keep no ETag.
 */

/** A page may be tagged only when nothing in it is for one person. */
export function taggable(request: Request, signedIn: boolean, flash: boolean): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !signedIn &&
    !flash
  );
}

export function weakEtag(bytes: string): string {
  return `W/"${Bun.hash(bytes).toString(36)}"`;
}

/** Whether `If-None-Match` holds this tag (weak comparison). */
export function holds(request: Request, etag: string): boolean {
  const held = request.headers.get("if-none-match");
  if (held === null) return false;
  if (held.trim() === "*") return true;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return held.split(",").some((t) => bare(t) === bare(etag));
}
