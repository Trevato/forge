/**
 * Cross-Origin-Resource-Policy: which of the forge's answers another site
 * may load as a no-cors subresource (#10965). The security floor makes every
 * answer `same-origin`, so a private page or API answer cannot be pulled into
 * another site's process and read there (a Spectre-class read). The answers
 * here are the exception, said on purpose: they are public by nature and
 * meant to be embedded or fetched from elsewhere — hashed assets, icons, the
 * crawler and agent files, the manifest, `/.well-known/*`, feeds, and the
 * share cards a link preview draws.
 *
 * Feeds and share cards can depend on who asks (a private repository's
 * activity), so they are `cross-origin` only for a request that carried no
 * credentials. A feed reader and a link preview send none; neither does a
 * cross-site embed, since the session cookie is SameSite=Lax.
 */

/** Paths whose answer is the same bytes for everyone. */
const ALWAYS: RegExp[] = [
  /^\/assets\//,
  /^\/icons\//,
  /^\/\.well-known\//,
  /^\/(?:favicon\.ico|robots\.txt|llms\.txt|sitemap\.xml|manifest\.webmanifest)$/,
  /^\/apple-touch-icon(?:-precomposed)?\.png$/,
];

/** Paths public to an anonymous reader, which may differ for a signed-in one. */
const ANONYMOUS: RegExp[] = [/\.atom$/, /^\/og\//];

/** Whether the answer to this request may be loaded by another origin. */
export function crossOriginAllowed(request: Request, pathname: string): boolean {
  if (ALWAYS.some((pattern) => pattern.test(pathname))) return true;
  if (!ANONYMOUS.some((pattern) => pattern.test(pathname))) return false;
  return !request.headers.has("cookie") && !request.headers.has("authorization");
}

/**
 * Marks a successful public answer `cross-origin` before the floor fills in
 * `same-origin` for everything else. A refusal or 404 on a public path stays
 * with the floor: an error is nobody's to embed.
 */
export function resourcePolicy(request: Request, response: Response): Response {
  if (response.status >= 400 || response.headers.has("cross-origin-resource-policy")) return response;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return response;
  }
  if (!crossOriginAllowed(request, pathname)) return response;
  try {
    response.headers.set("cross-origin-resource-policy", "cross-origin");
  } catch {
    // An immutable header set keeps what it came with; the floor leaves it too.
  }
  return response;
}
