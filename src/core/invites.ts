/**
 * Invite links: a secret handed out once, good for one signup, gone after a
 * deadline. The database holds only the token's hash, so a list can never
 * give a link back, and a token is found by its hash: nothing compares the
 * secret itself. While signup is `invite`, a stranger's signup with an open
 * invite is let in (`newAccountsClosed` in `core/users.ts`), and the invite is
 * spent in the same transaction as the account (`redeemInvite`).
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id, secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 30;
const DAY = 86_400_000;

export type InviteState = "open" | "used" | "revoked" | "expired";

export interface Invite {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: InviteState;
  /** When it was spent, or null. */
  readonly usedAt: string | null;
  /** The username it let in; null when unused or the account is gone. */
  readonly usedBy: string | null;
}

interface Row {
  id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
  used_by_name: string | null;
}

/** An invite with its redeemer's username, resolved in the one query. */
const SELECT = "SELECT invite.*, user.username AS used_by_name FROM invite LEFT JOIN user ON user.id = invite.used_by";

const stateOf = (r: Row, now: number): InviteState =>
  r.revoked_at !== null ? "revoked" : r.used_at !== null ? "used" : Date.parse(r.expires_at) <= now ? "expired" : "open";

const view = (r: Row, now: number): Invite => ({
  id: r.id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  state: stateOf(r, now),
  usedAt: r.used_at,
  usedBy: r.used_at === null ? null : r.used_by_name,
});

/** A whole number of days from 1 to 30, or the default when absent. */
export function parseDays(raw: unknown): Result<number, "invalid_days"> {
  if (raw === undefined || raw === null) return ok(DEFAULT_DAYS);
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_DAYS ? ok(raw) : err("invalid_days");
}

/** The token is returned here and nowhere else. */
export function mintInvite(
  db: Database,
  createdBy: string,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
): { invite: Invite; token: string } {
  const token = `invite_${secret()}`;
  const inviteId = id(now);
  db.query(
    "INSERT INTO invite (id, token_hash, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(inviteId, sha256(token), createdBy, new Date(now).toISOString(), new Date(now + days * DAY).toISOString());
  const row = db.query<Row, [string]>(`${SELECT} WHERE invite.id = ?1`).get(inviteId)!;
  return { invite: view(row, now), token };
}

/** Whether `token` names an invite still open now: not used, revoked or expired. */
export function inviteOpen(db: Database, token: string, now: number = Date.now()): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM invite WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2",
      )
      .get(sha256(token), new Date(now).toISOString()) !== null
  );
}

/**
 * Spend the open invite `token` names on `userId`, in one conditional write.
 * False when it was not open: of two sign-ups racing for one link, one wins.
 * The caller runs this in the transaction that makes the account.
 */
export function redeemInvite(db: Database, token: string, userId: string, now: number = Date.now()): boolean {
  const at = new Date(now).toISOString();
  return (
    db
      .query(
        "UPDATE invite SET used_at = ?2, used_by = ?3 WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2",
      )
      .run(sha256(token), at, userId).changes === 1
  );
}

/** Give back the invite an account spent, when that account is taken back. */
export function reopenInvite(db: Database, userId: string): void {
  db.query("UPDATE invite SET used_at = NULL, used_by = NULL WHERE used_by = ?1").run(userId);
}

/** Every invite, newest first, never with its token. */
export function listInvites(db: Database, now: number = Date.now()): Invite[] {
  return db
    .query<Row, []>(`${SELECT} ORDER BY invite.id DESC LIMIT 500`)
    .all()
    .map((r) => view(r, now));
}

/** Revoke an open invite. A used, revoked or unknown one is `not_found`. */
export function revokeInvite(
  db: Database,
  inviteId: string,
  now: number = Date.now(),
): Result<Invite, "not_found"> {
  const changed = db
    .query("UPDATE invite SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL AND used_at IS NULL")
    .run(inviteId, new Date(now).toISOString()).changes;
  if (changed === 0) return err("not_found");
  return ok(view(db.query<Row, [string]>(`${SELECT} WHERE invite.id = ?1`).get(inviteId)!, now));
}

/** The id of the invite an account spent, if one let it in. */
export function inviteSpentBy(db: Database, userId: string): string | undefined {
  return db.query<{ id: string }, [string]>("SELECT id FROM invite WHERE used_by = ?1").get(userId)?.id;
}
