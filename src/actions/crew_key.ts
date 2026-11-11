/**
 * The owner's own model key, saved from either door (#11154): the web form
 * (`POST /settings/crew/key`) and the terminal screen. A forge admin only;
 * the key is checked at the boundary, sealed by `addSubscription`, and
 * offered to the crew of the admin's apps and of the spawned organisation.
 * Never logged, never echoed.
 */

import type { App } from "../app.ts";
import { addSubscription, getSubscriptionByName, setGrants } from "../core/subscriptions.ts";
import type { User } from "../core/users.ts";
import { spawnedOrg } from "../spawn/claim.ts";

const KEY_NAME = "my-key";
/** The most bytes a key may be; the longest real one is well under it. */
export const KEY_MAX_BYTES = 512;

export type CrewKeyError = "not_found" | "invalid_token";

/** A key is one line of printable text, within {@link KEY_MAX_BYTES}. */
export function keyShapeOk(raw: string): boolean {
  const token = raw.trim();
  return token !== "" && Buffer.byteLength(token) <= KEY_MAX_BYTES && !/[\u0000-\u001f\u007f-\u009f]/.test(token);
}

export async function saveCrewKey(
  app: App,
  user: User | undefined,
  raw: string,
): Promise<{ ok: true } | { ok: false; error: CrewKeyError }> {
  if (user === undefined || !user.isAdmin || user.kind === "agent") return { ok: false, error: "not_found" };
  if (!keyShapeOk(raw)) return { ok: false, error: "invalid_token" };
  const name = getSubscriptionByName(app.db, KEY_NAME) === undefined ? KEY_NAME : `${KEY_NAME}-${Date.now().toString(36)}`;
  const added = addSubscription(app.db, app.config.dataDir, { name, token: raw.trim(), createdBy: user.id });
  if (!added.ok) return { ok: false, error: "invalid_token" };
  const spawned = await spawnedOrg(app);
  for (const scope of [user.id, ...(spawned === undefined ? [] : [spawned.org.id])]) {
    const held = app.db
      .query<{ subscription_id: string }, [string]>("SELECT subscription_id FROM subscription_grant WHERE scope_id = ?1 AND agent_id = ''")
      .all(scope)
      .map((r) => r.subscription_id);
    setGrants(app.db, scope, "", [...held, added.value.id]);
  }
  return { ok: true };
}
