/**
 * The timeline: what the viewer may see, newest first, paged by `before`.
 *
 * The ranked feed (`feed.ts`) is recomputed over a window of recent events
 * and cannot go deeper. This reads events straight from the log, in the order
 * they were written, so a page costs the page — the 50th as much as the
 * first — and a post that arrives between two requests lands above the
 * cursor, never repeating or skipping one below it. The cursor is an event's
 * id: a ULID, so it is its time and its identity in one (`kernel/id.ts`); the
 * log resolves it to its place in write order (`core/events.ts`), which is
 * total, so two posts in one millisecond cannot tie.
 *
 * Visibility is the log query's (`listEventsVisibleTo`) and the audience
 * filter's, never the cursor's: a cursor only names where to start, so a
 * forged one reads nothing the caller could not read. What it leaves out of
 * the ranked feed: shares, asks and other standing items (they are not in the
 * log), and the folding of bursts (a fold would straddle a page).
 */

import type { Database } from "bun:sqlite";
import { chipsOf, type Chips } from "../core/feed_chips.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../core/events.ts";
import { dismissedItems, mutedRepos } from "../core/interactions.ts";
import { getReposByIds } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { chipHides } from "./chips.ts";
import { decorate, FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX } from "./feed.ts";
import { eventCandidates } from "./items.ts";
import { ago, type FeedItem } from "./rank.ts";

/** `before=now` starts at the newest post. */
export const TIMELINE_START = "now";

const CURSOR = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A `before` as this forge issued it: an event id, or `now`. Anything else is undefined. */
export function parseBefore(raw: string): { id: string | undefined } | undefined {
  if (raw === TIMELINE_START) return { id: undefined };
  return CURSOR.test(raw) ? { id: raw } : undefined;
}

/** Events read per round trip, and rounds at most: a filter that hides most of the log ends the page short, with a cursor to go on. */
const BATCH = 100;
const ROUNDS = 5;

export function readTimeline(
  db: Database,
  viewer: User,
  options: {
    before?: string | undefined;
    limit?: number;
    now?: number;
    chips?: Chips;
    phase?: (name: string, ms: number) => void;
  } = {},
): { items: FeedItem[]; next_cursor: string | null } {
  const now = options.now ?? Date.now();
  const limit = Math.min(options.limit ?? FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX);
  const chips = options.chips ?? chipsOf(db, viewer.id);
  const muted = mutedRepos(db, viewer.id);
  const dismissed = dismissedItems(db, viewer.id);
  const picked: { item: FeedItem; event: string }[] = [];
  let before = options.before;
  let more = false; // the log has events past the last one read
  for (let round = 0; round < ROUNDS && picked.length <= limit; round++) {
    const batch: ForgeEvent[] = listEventsVisibleTo(db, viewer, {
      limit: BATCH,
      ...(before === undefined ? {} : { beforeId: before }),
    });
    if (batch.length === 0) {
      more = false;
      break;
    }
    before = batch[batch.length - 1]!.id;
    more = batch.length === BATCH;
    const heard = batch.filter(audienceFilter(db, viewer, batch));
    const repos = getReposByIds(db, heard.map((e) => e.repoId!));
    for (const c of eventCandidates(db, viewer, now, heard, repos)) {
      if (chipHides(chips, c) || dismissed.has(c.id) || muted.has(c.repoId)) continue;
      picked.push({
        event: c.id.slice("event:".length),
        item: {
          id: c.id,
          kind: c.kind,
          app: c.app,
          actor: c.actor,
          at: c.at,
          link: c.link,
          what: c.said ?? c.what,
          reason: c.said ?? ago(Date.parse(c.at), now),
          score: 0,
        },
      });
    }
  }
  // Candidates come out in the batch's order (newest first); the page is the first `limit`.
  const page = picked.slice(0, limit);
  const last = page[page.length - 1];
  const items = decorate(db, viewer, page.map((p) => p.item), options.phase);
  // More to read: a further post already found, or events left unread (the cursor is then where the read stopped).
  const next =
    picked.length > limit && last !== undefined
      ? last.event
      : more && before !== undefined
        ? before
        : null;
  return { items, next_cursor: next };
}
