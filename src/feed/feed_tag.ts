/**
 * The weak ETag of one viewer's feed page, and whether the viewer has shares
 * still waiting to be delivered.
 */

import type { Database } from "bun:sqlite";
import type { Chips } from "../core/feed_chips.ts";
import type { User } from "../core/users.ts";
import { writeStamp } from "../core/write_clock.ts";

/** One minute: the grain at which time itself changes a feed (ages, waits, decay). */
export const TAG_BUCKET_MS = 60_000;

/**
 * The tag of the page `GET /api/v1/feed` would answer: a hash of the viewer,
 * the switched-off chips, the cursor, the limit, the forge's write clock
 * (`writeStamp`: any insert, update or delete, so events, shares, dismissals
 * and their undoing, mutes, watches, pins, settled issues and visibility all
 * move it) and the minute of `now`. It is built from those, never from the
 * body, so a 304 costs none of the ranking. A pull crossing the 24 h wait
 * line changes the minute. Inside a transaction the clock has no value and
 * there is no tag: the caller sends none and never answers 304. The caller
 * also drains the viewer's share queue first and answers 200 while
 * `hasQueuedShares` holds, since the queue's delivery depends on the clock.
 */
export function feedTag(
  db: Database,
  viewer: User,
  input: {
    readonly chips: Chips;
    readonly cursor: string | null;
    readonly limit: number | null;
    readonly now?: number;
    /** The viewer's last visit to `/`, which the first page's digest is cut from. */
    readonly visit?: number | undefined;
  },
): string | undefined {
  const stamp = writeStamp(db);
  if (stamp === undefined) return undefined;
  const now = input.now ?? Date.now();
  const parts = [
    viewer.id,
    [...input.chips.kinds].sort().join(","),
    [...input.chips.people].sort().join(","),
    input.cursor ?? "",
    input.limit ?? "",
    stamp,
    Math.floor(now / TAG_BUCKET_MS),
    // Only the first page carries a digest, and the digest reads the last visit.
    input.cursor === null ? (input.visit ?? "") : "",
  ];
  return `W/"${Bun.hash(JSON.stringify(parts)).toString(36)}"`;
}

/** Whether a share to the viewer is still queued behind their daily budget. */
export function hasQueuedShares(db: Database, viewerId: string): boolean {
  return (
    db
      .query("SELECT 1 FROM share WHERE recipient_id = ?1 AND state = 'queued' LIMIT 1")
      .get(viewerId) !== null
  );
}
