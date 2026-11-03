/**
 * A guest pull: one whose author lives on another forge — it was brought in
 * from the origin (its issue names an `origin_author`) or its head lives in
 * a fork there (`originHeadRepo`). Its check and preview run without the
 * repository's secrets, and the crew does not review it, until a person —
 * never an agent — who can write the repository approves it once. The
 * approval is for the pull, not a head: a later push by the same author
 * runs with the secrets too — except a head moved on a read-only mirror,
 * which clears it (`forgetGuestApproval`, #9011). Whether a head's code
 * may run at all is still `core/pull_trust.ts`'s question, asked per head.
 * Pure data.
 */

import type { Database } from "bun:sqlite";
import { getIssueById } from "../core/issues.ts";
import type { Pull } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { foldsIn } from "../core/trusted_sources.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Whether `pull`'s author lives on another forge. */
export function isGuestPull(db: Database, pull: Pull): boolean {
  if (pull.originHeadRepo !== null) return true;
  return (getIssueById(db, pull.id)?.originAuthor ?? null) !== null;
}

/** Who approved the guest `pull`, and when; undefined until someone has. */
export function guestApproval(
  db: Database,
  pullId: string,
): { approvedBy: string; approvedAt: string } | undefined {
  const row = db
    .query<{ approved_by: string; approved_at: string }, [string]>(
      "SELECT approved_by, approved_at FROM guest_approval WHERE pull_id = ?1",
    )
    .get(pullId);
  return row === null
    ? undefined
    : { approvedBy: row.approved_by, approvedAt: row.approved_at };
}

/**
 * A guest nobody has approved yet: no secrets, no crew. A guest whose
 * account is a trusted source on its forge (`pull_source`, #9011) does not
 * wait: trust is that approval, for as long as it lasts.
 */
export function guestWaits(db: Database, pull: Pull): boolean {
  return isGuestPull(db, pull) && guestApproval(db, pull.id) === undefined && !foldsIn(db, pull.id);
}

/** Whether `user` may approve a guest on `repo`: a person who can write it. */
export const mayApproveGuest = (
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean => user !== undefined && user.kind === "user" && canWrite(db, repo, user);

/** Approve the guest `pull`, once. A second approval keeps the first. */
export function approveGuest(
  db: Database,
  repo: Repo,
  pull: Pull,
  user: User | undefined,
): Result<"approved" | "already", "forbidden" | "not_guest"> {
  if (!mayApproveGuest(db, repo, user) || user === undefined) return err("forbidden");
  if (!isGuestPull(db, pull)) return err("not_guest");
  const changed = db
    .query(
      "INSERT INTO guest_approval (pull_id, approved_by) VALUES (?1, ?2) ON CONFLICT (pull_id) DO NOTHING",
    )
    .run(pull.id, user.id).changes;
  return ok(changed === 0 ? "already" : "approved");
}

/**
 * Clear the guest `pull`'s approval: its head moved somewhere no one here
 * pushes (a read-only mirror's pull, #9011), so the head a person approved
 * is not the one that would run. It waits again until someone looks.
 */
export function forgetGuestApproval(db: Database, pullId: string): void {
  db.query("DELETE FROM guest_approval WHERE pull_id = ?1").run(pullId);
}
