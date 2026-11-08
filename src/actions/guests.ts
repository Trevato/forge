/**
 * What a guest may send and how much, asked when a guest forks or opens a pull
 * (`docs/ROLES.md`). Every number is a limit on `/admin/limits`, read on each
 * attempt. These paths only run for a guest's write, so a member or a page read
 * pays nothing for them.
 */

import type { App } from "../app.ts";
import {
  contributionForksSince,
  isContributionFork,
  type GuestRefusal,
} from "../core/contribute.ts";
import type { Repo } from "../core/repos.ts";
import { contributionRefusal } from "../core/storage.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { limitValue } from "../settings/limits.ts";
import { requireVerified } from "./verify.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const cooling = (app: App, user: User, now: number): boolean =>
  now - new Date(user.createdAt).getTime() < limitValue(app.db, "guest.cooldown_minutes") * MINUTE_MS;

const forgeForksSpent = (app: App, now: number): boolean =>
  contributionForksSince(app.db, new Date(now - DAY_MS).toISOString()) >= limitValue(app.db, "guest.forks_forge_per_day");

/** Which count refused a fork in the row's own write. */
export const forkLimitSpent = (app: App, now: number): GuestRefusal =>
  forgeForksSpent(app, now) ? "guest_forge_forks_today" : "guest_forks_today";

/** Why this guest may not fork `parent` now; undefined when they may. */
export async function guestForkRefusal(
  app: App,
  user: User,
  parent: Repo,
  now: number,
): Promise<GuestRefusal | undefined> {
  if (parent.visibility !== "public" || parent.sealedFor !== null) return "guest_private";
  if (isMirror(app, parent) || isContributionFork(app.db, parent.id)) return "guest_copy";
  if (parent.archivedAt !== null) return "guest_archived";
  if (cooling(app, user, now)) return "guest_cooldown";
  if (forgeForksSpent(app, now)) return "guest_forge_forks_today";
  if ((await contributionRefusal(app, user.id)) !== undefined) return "guest_storage";
  return undefined;
}

/**
 * Take one of a guest's pulls for today: head must be their own contribution
 * fork of `base`. The count and the row are one synchronous step, so pulls
 * sent at once cannot pass together; `refund` gives the place back when the
 * pull is not made after all.
 */
export function takeGuestPull(
  app: App,
  user: User,
  base: Repo,
  head: Repo | undefined,
  now: number,
): Result<{ refund: () => void }, GuestRefusal | "unverified"> {
  const proven = requireVerified(app, user);
  if (!proven.ok) return proven;
  if (head === undefined || head.ownerId !== user.id || head.forkParentId !== base.id || !isContributionFork(app.db, head.id))
    return err("guest_pull_shape");
  if (cooling(app, user, now)) return err("guest_cooldown");
  const db = app.db;
  const made = db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM guest_pull_made WHERE owner_id = ?1 AND made_at >= ?2",
    )
    .get(user.id, now - DAY_MS)?.n ?? 0;
  if (made >= limitValue(db, "guest.pulls_per_day")) return err("guest_pulls_today");
  db.query("DELETE FROM guest_pull_made WHERE owner_id = ?1 AND made_at < ?2").run(user.id, now - DAY_MS);
  const row = db.query("INSERT INTO guest_pull_made (owner_id, made_at) VALUES (?1, ?2)").run(user.id, now);
  return ok({
    refund: () => {
      db.query("DELETE FROM guest_pull_made WHERE rowid = ?1").run(row.lastInsertRowid);
    },
  });
}
