/**
 * Every message the forge sent, by a hash of its recipient: what the mail
 * caps (`actions/mail.ts`) count, so they hold across a restart. The address
 * itself is never kept here — a hash of it, lowercased, is enough to count.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id } from "../kernel/id.ts";

/** The key a recipient is counted by. */
export function recipientKey(address: string): string {
  return sha256(address.trim().toLowerCase());
}

/** Hold a place for a message about to go; returns its row, to release if it fails. */
export function holdSend(db: Database, recipient: string, at: string): string {
  const row = id();
  db.query("INSERT INTO mail_sent (id, recipient, at) VALUES (?1, ?2, ?3)").run(
    row,
    recipient,
    at,
  );
  return row;
}

/** A message that did not go: it counts against nothing. */
export function releaseSend(db: Database, row: string): void {
  db.query("DELETE FROM mail_sent WHERE id = ?1").run(row);
}

/** Messages sent since `since`, to anyone or to one recipient. */
export function sentSince(
  db: Database,
  since: string,
  recipient?: string,
): number {
  const row =
    recipient === undefined
      ? db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM mail_sent WHERE at > ?1",
          )
          .get(since)
      : db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM mail_sent WHERE recipient = ?1 AND at > ?2",
          )
          .get(recipient, since);
  return row?.n ?? 0;
}
