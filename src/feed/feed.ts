/**
 * One viewer's feed: candidates the viewer may see, less what they muted or
 * dismissed, ranked, then a page of it. A muted app goes quiet except for
 * asks — something that waits on a person is never muted away. The cursor
 * is the last item's `score|id`; the feed is recomputed each time, and the
 * cursor finds its place by id, or by score when that item is gone.
 */

import type { Database } from "bun:sqlite";
import { dismissedItems, mutedRepos } from "../core/interactions.ts";
import type { User } from "../core/users.ts";
import { affinityFor } from "./affinity.ts";
import { candidatesFor } from "./items.ts";
import { rank, type FeedItem } from "./rank.ts";

export const FEED_LIMIT_DEFAULT = 20;
export const FEED_LIMIT_MAX = 50;

const CURSOR = /^(-?\d{1,6}(?:\.\d{1,6})?)\|([a-z]{2,12}:[A-Za-z0-9_.:-]{1,160})$/;

export const cursorOf = (item: FeedItem): string => `${item.score}|${item.id}`;

/** A cursor as it was issued, or undefined for anything else. */
export function parseCursor(
  raw: string,
): { score: number; id: string } | undefined {
  const m = CURSOR.exec(raw);
  return m ? { score: Number(m[1]), id: m[2]! } : undefined;
}

export function readFeed(
  db: Database,
  viewer: User,
  options: { limit?: number; cursor?: { score: number; id: string }; now?: number } = {},
): { items: FeedItem[]; next_cursor: string | null } {
  const now = options.now ?? Date.now();
  const limit = Math.min(options.limit ?? FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX);
  const muted = mutedRepos(db, viewer.id);
  const dismissed = dismissedItems(db, viewer.id);
  const candidates = candidatesFor(db, viewer, now).filter(
    (c) => !dismissed.has(c.id) && (c.kind === "ask" || !muted.has(c.repoId)),
  );
  let ranked = rank(candidates, affinityFor(db, viewer, now), now);
  const cursor = options.cursor;
  if (cursor) {
    const at = ranked.findIndex((i) => i.id === cursor.id);
    ranked =
      at >= 0
        ? ranked.slice(at + 1)
        : ranked.filter((i) => i.score < cursor.score);
  }
  const items = ranked.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    next_cursor:
      ranked.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}
