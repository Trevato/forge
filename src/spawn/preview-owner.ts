/**
 * Who the parent forge vouches for, in a preview of this one (#8812). A
 * forge run as an app of another hears the visitor in `x-forge-identity`,
 * signed under `FORGE_APP_IDENTITY_KEY` (`apps/proxy.ts`); the parent drops
 * any copy a client sent, so a verified signature is the parent's word.
 *
 * In a preview, and only there, a visitor the parent names as an admin of
 * the repository — a writer, or the parent's looks taken as the owner — is
 * this forge's preview admin (`spawn/preview-seed.ts`). A writer can push a
 * branch that runs anything over a preview's data, so this grants nothing
 * they lacked. Anyone else, and every request in production, is left to
 * the forge's own sign-in: production is never handed the key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { isPreviewEnv, previewAdmin } from "./preview-seed.ts";

type Env = Record<string, string | undefined>;

/** The key a preview verifies the parent's identity with; none in production. */
export function previewIdentityKey(env: Env = process.env): string | undefined {
  if (!isPreviewEnv(env)) return undefined;
  const key = (env.FORGE_APP_IDENTITY_KEY ?? "").trim();
  return key === "" ? undefined : key;
}

/** The preview admin, when the parent vouches for an admin on this request. */
export function previewOwner(
  app: App,
  request: Request,
  now = Date.now(),
): User | undefined {
  const key = app.config.previewIdentityKey;
  if (key === undefined || key === "") return undefined;
  const identity = request.headers.get("x-forge-identity");
  const signature = request.headers.get("x-forge-signature");
  if (identity === null || signature === null) return undefined;
  const expected = Buffer.from(
    createHmac("sha256", key).update(identity).digest("base64url"),
  );
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  const parts = identity.split("|");
  if (parts.length !== 4) return undefined;
  const [, , role, expires] = parts as [string, string, string, string];
  if (role !== "admin" || !/^\d+$/.test(expires) || Number(expires) <= now)
    return undefined;
  return previewAdmin(app);
}
