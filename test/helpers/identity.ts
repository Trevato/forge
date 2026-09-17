/**
 * Being the forge for an app: the identity headers the proxy signs for
 * every request it hands on (the scaffold's `src/who.ts` verifies them).
 * A suite puts `IDENTITY_KEY` in its environment before the runtime starts,
 * and `appEnv` hands it to every app it boots as `FORGE_APP_IDENTITY_KEY`.
 */

import { createHmac } from "node:crypto";

export const IDENTITY_KEY = "forge-tests-identity-key";

export function signedAs(
  user: { readonly id: string; readonly username: string },
  role: "user" | "admin" = "user",
  key = IDENTITY_KEY,
): Record<string, string> {
  const identity = `${user.id}|${user.username}|${role}|${Date.now() + 60_000}`;
  return {
    "x-forge-identity": identity,
    "x-forge-signature": createHmac("sha256", key)
      .update(identity)
      .digest("base64url"),
  };
}
