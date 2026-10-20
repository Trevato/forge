/**
 * A signed-out page that has not changed costs a header, not a body
 * (specification.website/#caching). The ETag is weak and computed from the
 * body's bytes; a request holding it is answered 304 with the page's own
 * headers.
 *
 * A page names a nonce in its body and in its policy. Left random, the 304
 * would renew the policy over a cached body that holds the old nonce and the
 * page's scripts would stop. So a page that is eligible takes its nonce from
 * an HMAC, under a key that lives only in this process, of the body it
 * guards: the same bytes give the same nonce, any byte an attacker reflects
 * into the page gives one they cannot predict. Signed-in pages, any that
 * show a flash, and any that are not 200 keep a random nonce and no ETag.
 */

import { secret } from "../kernel/id.ts";

const key = new TextEncoder().encode(secret());

/** A page may be tagged only when nothing in it is for one person. */
export function taggable(request: Request, signedIn: boolean, flash: boolean): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !signedIn &&
    !flash
  );
}

/** The nonce a page's markup (written with `placeholder`) is bound to. */
export function nonceFor(markup: string, placeholder: string): string {
  const h = new Bun.CryptoHasher("sha256", key);
  h.update(markup.replaceAll(placeholder, ""));
  return h.digest("base64url");
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
