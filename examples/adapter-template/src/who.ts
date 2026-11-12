/**
 * Who is asking. The forge signs every request it proxies to the app
 * (docs/APPS.md, "Who is there"):
 *
 *   x-forge-identity:  <userId>|<username>|<role>|<expiresMs>
 *   x-forge-signature: base64url(HMAC-SHA256(FORGE_APP_IDENTITY_KEY, that string))
 *
 * `role` is `user` or `admin` (one who may write the app's repository). The
 * forge drops any copy of these headers a client sends, so a signature that
 * verifies is the only trust there is: no headers, no key, a bad signature
 * or an expiry in the past all mean `anon`. The same check as the forge's
 * app scaffold (`src/who.ts` there).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type Who =
  | { readonly role: "anon" }
  | { readonly role: "user" | "admin"; readonly id: string; readonly name: string };

export const ANON: Who = { role: "anon" };

export function who(request: Request, key: string, now = Date.now()): Who {
  const identity = request.headers.get("x-forge-identity");
  const signature = request.headers.get("x-forge-signature");
  if (key === "" || identity === null || signature === null) return ANON;
  if (!same(sign(identity, key), signature)) return ANON;
  const parts = identity.split("|");
  if (parts.length !== 4) return ANON;
  const [id, name, role, expires] = parts as [string, string, string, string];
  if (role !== "user" && role !== "admin") return ANON;
  if (id === "" || name === "" || !/^\d+$/.test(expires) || Number(expires) <= now) return ANON;
  return { role, id, name };
}

/** The signature the forge computes. Exported so a test can be the forge. */
export const sign = (identity: string, key: string): string =>
  createHmac("sha256", key).update(identity).digest("base64url");

/** Constant-time: the compare takes as long for a near miss as for a far one. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
