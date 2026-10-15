/**
 * One viewer's feed: candidates the viewer may see, less what they muted or
 * dismissed, ranked, then a page of it. A muted app goes quiet except for
 * asks — something that waits on a person is never muted away. The cursor
 * is the last item's `score|id`; the feed is recomputed each time, and the
 * cursor finds its place by id, or by score when that item is gone.
 */

import type { Database } from "bun:sqlite";
import { chipsOf } from "../core/feed_chips.ts";
import { chipHides } from "./chips.ts";
import { dismissedItems, mutedRepos } from "../core/interactions.ts";
import { affinityFor } from "./affinity.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import { deliveredFor, drainQueue, senderWeight } from "../core/shares.ts";
import { getUserById, type User } from "../core/users.ts";
import { candidatesFor, type Candidate } from "./items.ts";
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
  const chips = chipsOf(db, viewer.id);
  drainQueue(db, viewer.id, now);
  const shared = sharedCandidates(db, viewer, now).filter(
    (c) => !dismissed.has(c.itemId),
  );
  const boosted = new Set(shared.map((c) => c.itemId));
  const candidates = [
    ...candidatesFor(db, viewer, now).filter((c) => !boosted.has(c.id)),
    ...shared,
  ]
    // The chips: the one filter. An ask was filtered by it in `askLinesFor`.
    .filter((c) => c.kind === "ask" || !chipHides(chips, c))
    .filter((c) =>
    // An ask is never muted away. Its own dismissal was already read by
    // `askLinesFor`, cause-aware: it comes back when something new happens.
    // A milestone the viewer chose to watch is not muted with its app.
    c.id.startsWith("ask:")
      ? true
      : !dismissed.has(c.id) &&
        (c.kind === "ask" ||
          c.kind === "milestone" ||
          c.kind === "choose" ||
          !muted.has(c.repoId)),
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

export const SHARE_BOOST = 3;

/**
 * What others shared with the viewer, as candidates that carry the item's
 * own words, boosted by the sender's weight. A repository the viewer can
 * no longer read says nothing. The shared item replaces the plain one.
 */
function sharedCandidates(
  db: Database,
  viewer: User,
  now: number,
): (Candidate & { itemId: string })[] {
  const out: (Candidate & { itemId: string })[] = [];
  for (const s of deliveredFor(db, viewer.id, now)) {
    const repo = getRepoById(db, s.repoId);
    const sender = getUserById(db, s.senderId);
    if (!repo || !sender || !canRead(db, repo, viewer)) continue;
    out.push({
      id: `share:${s.id}`,
      itemId: s.itemId,
      kind: s.kind as Candidate["kind"],
      repoId: repo.id,
      app: `${repo.ownerName}/${repo.name}`,
      actorId: sender.id,
      actor: sender.username,
      at: s.deliveredAt ?? s.createdAt,
      link: s.link,
      what: s.what,
      urgency: SHARE_BOOST * senderWeight(db, sender.id, now),
      said: `shared by ${sender.username}: ${s.what}`,
    });
  }
  return out;
}
