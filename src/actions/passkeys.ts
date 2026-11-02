/**
 * Removing one's own passkey, with the one rule both doors share (#8043):
 * Settings → Passkeys and MCP `whoami_can` refuse to remove the account's
 * last passkey when no password could sign it in instead. An account with
 * no passkey at all (edge sign-in) never reaches the rule: there is nothing
 * of its own to remove.
 */
import type { App } from "../app.ts";
import { listPasskeys, removePasskey } from "../core/passkeys.ts";
import { hasPassword, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const LAST_WAY_IN = "That is your only way to sign in. Add another passkey or set a password first.";

export function removeOwnPasskey(
  app: App,
  user: User,
  id: string,
): Result<void, "not_found" | "last_way_in"> {
  // One transaction: two removals racing cannot each see the other's key.
  return app.db.transaction((): Result<void, "not_found" | "last_way_in"> => {
    const keys = listPasskeys(app.db, user.id);
    if (!keys.some((k) => k.id === id)) return err("not_found");
    if (keys.length === 1 && !hasPassword(app.db, user.id)) return err("last_way_in");
    return removePasskey(app.db, user.id, id) ? ok() : err("not_found");
  })();
}
