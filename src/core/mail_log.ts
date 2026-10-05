/**
 * Every message the forge sent, by a keyed hash of its recipient: what the
 * mail caps (`actions/mail.ts`) count, so they hold across a restart. The
 * address itself is never kept here, and the hash is keyed with the data
 * directory's secret, so a copy of the database cannot be tested against a
 * list of addresses.
 */

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { id } from "../kernel/id.ts";
import { loadKey } from "../kernel/secret.ts";

/** Mail providers that ignore dots in the local part, and their one domain. */
const DOTLESS: Record<string, string> = {
  "gmail.com": "gmail.com",
  "googlemail.com": "gmail.com",
};

/**
 * The mailbox an address reaches, as far as the forge can tell: lowercased,
 * a `+tag` dropped, and for Gmail its dots dropped and its two domains made
 * one. So `Ann+1@gmail.com`, `a.nn@googlemail.com` and `ann@gmail.com` are
 * one person to the caps.
 */
export function mailbox(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  const folded = DOTLESS[domain];
  if (folded !== undefined) {
    local = local.replaceAll(".", "");
    domain = folded;
  }
  return `${local}@${domain}`;
}

/** The key a recipient is counted by: its mailbox, keyed with the forge's secret. */
export function recipientKey(dataDir: string, address: string): string {
  return createHmac("sha256", loadKey(dataDir))
    .update(`mail-recipient:${mailbox(address)}`)
    .digest("hex");
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
