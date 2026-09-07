/**
 * A platform edge in front of the forge signs people in for every app it
 * serves and says who they are in two headers: `X-Plat-User`, the account,
 * and `X-Plat-Edge-Token`, a secret only the edge holds. A request carrying
 * the secret the operator configured (`FORGE_EDGE_TOKEN`) is that person,
 * signed in by the platform. Without the secret the headers are a claim
 * anyone could write, and they are ignored. Signing in and out are the
 * edge's own entry points on this host.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The account the edge vouches for on this request, if it does. */
export function edgeIdentity(
  request: Request,
  edgeToken: string | undefined,
): string | undefined {
  if (edgeToken === undefined || edgeToken === "") return undefined;
  const presented = request.headers.get("x-plat-edge-token") ?? "";
  if (!sameSecret(presented, edgeToken)) return undefined;
  const login = (request.headers.get("x-plat-user") ?? "").trim();
  return login === "" ? undefined : login;
}

// Compared as fixed-width digests, so neither the time taken nor the
// lengths compared depend on the secret.
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Where the edge starts a sign-in, coming back to `path` on this host. */
export function edgeLoginUrl(path: string): string {
  return `/_plat/login?rd=${encodeURIComponent(samePath(path))}`;
}

/** Where the edge ends the session, coming back to `path` on this host. */
export function edgeLogoutUrl(path: string): string {
  return `/_plat/logout?rd=${encodeURIComponent(samePath(path))}`;
}

/**
 * A return target is a path on this host, never a URL: anything that could
 * name another host — a scheme, `//`, `/\` — or carry whitespace or a
 * control character becomes the root.
 */
function samePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\"))
    return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(path)) return "/";
  return path.split("#")[0] || "/";
}
