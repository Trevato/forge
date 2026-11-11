/**
 * The app limit (`settings/quotas.ts`): when a forge admin has set one, an
 * account may own that many apps and no more. A forge admin is never held
 * to it, and with no limit set nothing is asked. The check and the insert
 * are separate statements, so two concurrent creates can pass by one: the
 * limit is a soft quota, not a lock.
 */

import type { App } from "../app.ts";
import { quotaOf } from "../settings/quotas.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Apps whose repository belongs to the account. */
export function appsOwnedBy(app: App, ownerId: string): number {
  return (
    app.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM app JOIN repo ON repo.id = app.repo_id WHERE repo.owner_id = ?1",
      )
      .get(ownerId)?.n ?? 0
  );
}

/** The refusal, in words: the limit and the count, e.g. "3 of 3 apps". */
export function appLimitWords(app: App, ownerId: string): string {
  const limit = quotaOf(app.db, "apps", ownerId) ?? 0;
  return `This account is at its limit: ${Math.min(appsOwnedBy(app, ownerId), limit)} of ${limit} apps. Remove one to make room.`;
}

/** Room for one more app under `ownerId`, for `actor` to make. */
export function requireAppRoom(
  app: App,
  actor: User,
  ownerId: string,
): Result<void, "app_limit"> {
  if (actor.isAdmin) return ok();
  const limit = quotaOf(app.db, "apps", ownerId);
  if (limit === null || appsOwnedBy(app, ownerId) < limit) return ok();
  return err("app_limit");
}
