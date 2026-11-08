/**
 * The secret in an `Authorization` header that names a token: `Bearer <secret>`
 * and `token <secret>`, the scheme a Gitea client sends. Nothing else is a
 * token header, and a header with the scheme but no secret is not one either,
 * so a malformed header never reaches `verifyToken` with a guessed slice.
 */

const SCHEMES = ["Bearer ", "token "] as const;

/** The secret, or `null` when the header is not a token header or holds none. */
export function tokenSecret(header: string): string | null {
  for (const scheme of SCHEMES) {
    if (!header.startsWith(scheme)) continue;
    const secret = header.slice(scheme.length).trim();
    return secret === "" ? null : secret;
  }
  return null;
}

/** Whether the header names a token scheme at all, empty secret or not. */
export function isTokenScheme(header: string): boolean {
  return SCHEMES.some((scheme) => header.startsWith(scheme));
}
