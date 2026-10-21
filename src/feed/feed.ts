/**
 * One viewer's feed: candidates the viewer may see, less what they muted or
 * dismissed, ranked, then a page of it. A muted app goes quiet except for
 * asks — something that waits on a person is never muted away. The cursor
 * is the last item's `score|id`; the feed is recomputed each time, and the
 * cursor finds its place by id, or by score when that item is gone.
 */

import type { Database } from "bun:sqlite";
import { chipsOf, type Chips } from "../core/feed_chips.ts";
import { chipHides } from "./chips.ts";
import { dismissedItems, mutedRepos } from "../core/interactions.ts";
import { affinityFor } from "./affinity.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import { deliveredFor, drainQueue, senderWeight } from "../core/shares.ts";
import { getUserById, type User } from "../core/users.ts";
import { candidatesFor, type Candidate } from "./items.ts";
import { writeStamp } from "../core/write_clock.ts";
import { Stamped } from "../kernel/stamped.ts";
import { rank, type FeedItem } from "./rank.ts";

export const FEED_LIMIT_DEFAULT = 20;
export const FEED_LIMIT_MAX = 50;

const CURSOR = /^(-?\d{1,6}(?:\.\d{1,6})?)\|([a-z]{2,12}:[A-Za-z0-9_.:-]{1,160})$/;

export const cursorOf = (item: FeedItem): string => `${item.score}|${item.id}`;

/**
 * One viewer's candidates, read again only after a write (docs/CACHING.md).
 * Keyed by the viewer, their chips and whether asks are in — never shared between two people,
 * since what an event says depends on who may read it — and stamped with
 * the forge's write clock, so any write anywhere recomputes it. The max age bounds
 * what no clock sees: candidates stamped with "now", and the windows of
 * watched and frozen items.
 */
const feedCaches = new WeakMap<Database, Stamped<Candidate[]>>();

export const FEED_CANDIDATES_MAX_AGE_MS = 30_000;

/** The candidate cache of `db`: for tests and the bench, which count its hits. */
export function feedCandidateCache(db: Database): Stamped<Candidate[]> {
  let cache = feedCaches.get(db);
  if (cache === undefined) {
    cache = new Stamped<Candidate[]>({
      maxEntries: 200,
      maxAgeMs: FEED_CANDIDATES_MAX_AGE_MS,
    });
    feedCaches.set(db, cache);
  }
  return cache;
}

function viewerCandidates(
  db: Database,
  viewer: User,
  now: number,
  chips: Chips,
  withAsks: boolean,
): readonly Candidate[] {
  const stamp = writeStamp(db);
  if (stamp === undefined) return candidatesFor(db, viewer, now, chips, withAsks);
  // Home asks without its asks (it pins them above): a different list, a different key.
  const key = `${viewer.id}|${withAsks ? "asks" : "no-asks"}|${[...chips.kinds].sort().join(",")}|${[...chips.people].sort().join(",")}`;
  return feedCandidateCache(db).get(key, stamp, () =>
    candidatesFor(db, viewer, now, chips, withAsks),
  );
}

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
  options: {
    limit?: number;
    cursor?: { score: number; id: string };
    now?: number;
    chips?: Chips;
    /** The home pins asks above the feed: they must not fill its page. */
    withoutAsks?: boolean;
  } = {},
): { items: FeedItem[]; next_cursor: string | null } {
  const now = options.now ?? Date.now();
  const limit = Math.min(options.limit ?? FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX);
  const muted = mutedRepos(db, viewer.id);
  const dismissed = dismissedItems(db, viewer.id);
  const chips = options.chips ?? chipsOf(db, viewer.id);
  drainQueue(db, viewer.id, now);
  const shared = sharedCandidates(db, viewer, now).filter(
    (c) => !dismissed.has(c.itemId),
  );
  const boosted = new Set(shared.map((c) => c.itemId));
  const candidates = [
    ...(options.now === undefined
      ? viewerCandidates(db, viewer, now, chips, options.withoutAsks !== true)
      : candidatesFor(db, viewer, now, chips, options.withoutAsks !== true)
    ).filter((c) => !boosted.has(c.id)),
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
  const pageable =
    options.withoutAsks === true ? candidates.filter((c) => c.kind !== "ask") : candidates;
  const cursor = options.cursor;
  // Without a cursor only the page and one more (to know there is a next) are placed.
  let ranked = rank(
    pageable,
    affinityFor(db, viewer, now),
    now,
    cursor === undefined ? limit + 1 : Infinity,
  );
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
