/**
 * Shares as data: one row per item and recipient, ever (the dedupe). A
 * share is delivered, queued behind the recipient's daily budget, or
 * dropped once it has waited too long. Pure data: the verb that makes one
 * (`feed/share.ts`) owes the access check.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { limitValue } from "../settings/limits.ts";

export const QUEUE_TTL_MS = 48 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const WEIGHT_WINDOW_MS = 90 * DAY_MS;
export const WEIGHT_MIN = 0.2;
export const WEIGHT_MAX = 2;

export type ShareState = "delivered" | "queued" | "dropped";

export interface Share {
  readonly id: string;
  readonly itemId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly repoId: string;
  readonly kind: string;
  readonly link: string;
  readonly what: string;
  readonly state: ShareState;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

interface Row {
  id: string;
  item_id: string;
  sender_id: string;
  recipient_id: string;
  repo_id: string;
  kind: string;
  link: string;
  what: string;
  state: ShareState;
  created_at: string;
  delivered_at: string | null;
}

const toShare = (r: Row): Share => ({
  id: r.id,
  itemId: r.item_id,
  senderId: r.sender_id,
  recipientId: r.recipient_id,
  repoId: r.repo_id,
  kind: r.kind,
  link: r.link,
  what: r.what,
  state: r.state,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** Whether this item was ever shared with this recipient, in any state. */
export function wasShared(
  db: Database,
  itemId: string,
  recipientId: string,
): boolean {
  return (
    db
      .query("SELECT 1 FROM share WHERE item_id = ?1 AND recipient_id = ?2")
      .get(itemId, recipientId) !== null
  );
}

/** Shares delivered to this recipient in the last day. */
export function deliveredToday(
  db: Database,
  recipientId: string,
  now: number,
): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM share WHERE recipient_id = ?1 AND state = 'delivered' AND delivered_at > ?2",
      )
      .get(recipientId, iso(now - DAY_MS))?.n ?? 0
  );
}

/**
 * A sender's weight from their past shares: the share-to-open rate, with a
 * prior of one open in two, so a newcomer is 1 and a sender nobody opens
 * sinks toward `WEIGHT_MIN` while one who is always opened rises to `WEIGHT_MAX`.
 */
export function senderWeight(
  db: Database,
  senderId: string,
  now: number,
): number {
  const row = db
    .query<{ n: number; opened: number }, [string, string]>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(EXISTS (
         SELECT 1 FROM interaction i
         WHERE i.viewer_id = share.recipient_id AND i.kind = 'opened'
           AND i.item_id IN (share.item_id, 'share:' || share.id))), 0) AS opened
       FROM share
       WHERE sender_id = ?1 AND state = 'delivered' AND delivered_at > ?2
         AND recipient_id NOT IN (SELECT user_id FROM agent)`,
    )
    .get(senderId, iso(now - WEIGHT_WINDOW_MS));
  const n = row?.n ?? 0;
  const opened = row?.opened ?? 0;
  const w = (2 * (opened + 1)) / (n + 2);
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
}

export function addShare(
  db: Database,
  input: Omit<Share, "id" | "state" | "createdAt" | "deliveredAt"> & {
    state: "delivered" | "queued";
    at: number;
  },
): Share {
  const row: Row = {
    id: id(),
    item_id: input.itemId,
    sender_id: input.senderId,
    recipient_id: input.recipientId,
    repo_id: input.repoId,
    kind: input.kind,
    link: input.link,
    what: input.what,
    state: input.state,
    created_at: iso(input.at),
    delivered_at: input.state === "delivered" ? iso(input.at) : null,
  };
  db.query(
    `INSERT INTO share (id, item_id, sender_id, recipient_id, repo_id, kind, link, what, state, created_at, delivered_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  ).run(
    row.id,
    row.item_id,
    row.sender_id,
    row.recipient_id,
    row.repo_id,
    row.kind,
    row.link,
    row.what,
    row.state,
    row.created_at,
    row.delivered_at,
  );
  return toShare(row);
}

/** Delivered shares for a recipient, newest first, within a week. */
export function deliveredFor(
  db: Database,
  recipientId: string,
  now: number,
): Share[] {
  return db
    .query<Row, [string, string]>(
      `SELECT * FROM share WHERE recipient_id = ?1 AND state = 'delivered'
       AND delivered_at > ?2 ORDER BY delivered_at DESC, id DESC LIMIT 50`,
    )
    .all(recipientId, iso(now - 7 * DAY_MS))
    .map(toShare);
}

/**
 * Let the queue move: what waited past its time is dropped, and while the
 * day's budget has room the best-weighted waiting share is delivered, the
 * older first among equals. Returns how many were delivered.
 */
export function drainQueue(
  db: Database,
  recipientId: string,
  now: number,
): number {
  db.query(
    "UPDATE share SET state = 'dropped' WHERE recipient_id = ?1 AND state = 'queued' AND created_at < ?2",
  ).run(recipientId, iso(now - QUEUE_TTL_MS));
  const waiting = db
    .query<Row, [string]>(
      "SELECT * FROM share WHERE recipient_id = ?1 AND state = 'queued' ORDER BY created_at, id",
    )
    .all(recipientId);
  if (waiting.length === 0) return 0;
  let room = limitValue(db, "share.daily_max") - deliveredToday(db, recipientId, now);
  const weights = new Map<string, number>();
  const w = (s: string): number => {
    if (!weights.has(s)) weights.set(s, senderWeight(db, s, now));
    return weights.get(s)!;
  };
  // A waiting share has decayed by its age: weight × (1 − age / ttl).
  const worth = (r: Row): number =>
    w(r.sender_id) * (1 - (now - Date.parse(r.created_at)) / QUEUE_TTL_MS);
  waiting.sort((a, b) => worth(b) - worth(a));
  let moved = 0;
  for (const r of waiting) {
    if (room <= 0) break;
    db.query(
      "UPDATE share SET state = 'delivered', delivered_at = ?2 WHERE id = ?1",
    ).run(r.id, iso(now));
    room--;
    moved++;
  }
  return moved;
}
