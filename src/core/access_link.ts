/**
 * An admin's one-time access link for a person, and the notices a person is
 * told the next time they are here. Pure data: `actions/account_access.ts`
 * decides who may make or spend one.
 *
 * Only the hash of a link's secret is kept. A link is good for an hour and
 * is spent by exactly one redemption, in the statement that checks it, so
 * two at once cannot both win. Making a new link for a person withdraws
 * their older ones.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id as newId, secret } from "../kernel/id.ts";

export const ACCESS_LINK_TTL_MS = 3_600_000;

/** Make a link for `userId`; its secret is returned once and never kept. */
export function makeAccessLink(
  db: Database,
  userId: string,
  createdBy: string,
  now: number,
): { token: string; expiresAt: string } {
  const token = secret();
  const expiresAt = new Date(now + ACCESS_LINK_TTL_MS).toISOString();
  db.transaction(() => {
    db.query("UPDATE access_link SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL").run(
      userId,
      new Date(now).toISOString(),
    );
    db.query(
      `INSERT INTO access_link (id, user_id, token_hash, created_by, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).run(newId(), userId, sha256(token), createdBy, new Date(now).toISOString(), expiresAt);
  })();
  return { token, expiresAt };
}

/** Whose link this is while it still works; nothing is spent. */
export function accessLinkOwner(db: Database, token: string, now: number): string | undefined {
  if (token === "") return undefined;
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM access_link WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
      )
      .get(sha256(token), new Date(now).toISOString())?.user_id ?? undefined
  );
}

/** Spend a link: whose it was, once; undefined after, or when it has lapsed. */
export function spendAccessLink(db: Database, token: string, now: number): string | undefined {
  if (token === "") return undefined;
  const at = new Date(now).toISOString();
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        `UPDATE access_link SET used_at = ?2
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         RETURNING user_id`,
      )
      .get(sha256(token), at)?.user_id ?? undefined
  );
}

/** Leave a notice for a person to read the next time they are here. */
export function leaveNotice(db: Database, userId: string, text: string, at: Date): void {
  db.query("INSERT INTO account_notice (user_id, text, at) VALUES (?1, ?2, ?3)").run(
    userId,
    text,
    at.toISOString(),
  );
}

/** The oldest notice not yet shown, marked shown by being taken; undefined when there is none. */
export function takeNotice(db: Database, userId: string, now: Date): string | undefined {
  return (
    db
      .query<{ text: string }, [string, string]>(
        `UPDATE account_notice SET seen_at = ?2
         WHERE id = (SELECT id FROM account_notice WHERE user_id = ?1 AND seen_at IS NULL ORDER BY id LIMIT 1)
         RETURNING text`,
      )
      .get(userId, now.toISOString())?.text ?? undefined
  );
}
