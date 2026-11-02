/**
 * What a viewer did with a feed item. One row per act, never edited; the
 * feed's affinity is these rows counted with a decay (`feed/affinity.ts`).
 * Pure data: the route that records one owes the access check.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export const INTERACTION_KINDS = [
  "opened",
  "dwelled",
  "steered",
  "told",
  "swiped",
  "shipped",
  "shared",
  "dismissed",
  "muted",
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/** A feed item id: a namespace, then what it names — `event:01J…`, `ask:look:…`. */
export const ITEM_ID = /^[a-z]{2,12}:[A-Za-z0-9_.:-]{1,160}$/;

export interface Interaction {
  readonly id: string;
  readonly viewerId: string;
  readonly itemId: string;
  readonly kind: InteractionKind;
  readonly repoId: string | null;
  readonly actorId: string | null;
  readonly createdAt: string;
}

interface Row {
  id: string;
  viewer_id: string;
  item_id: string;
  kind: InteractionKind;
  repo_id: string | null;
  actor_id: string | null;
  created_at: string;
}

const toInteraction = (r: Row): Interaction => ({
  id: r.id,
  viewerId: r.viewer_id,
  itemId: r.item_id,
  kind: r.kind,
  repoId: r.repo_id,
  actorId: r.actor_id,
  createdAt: r.created_at,
});

export function recordInteraction(
  db: Database,
  input: {
    viewerId: string;
    itemId: string;
    kind: InteractionKind;
    repoId: string | null;
    actorId: string | null;
    at?: string;
  },
): Interaction {
  const row: Row = {
    id: id(),
    viewer_id: input.viewerId,
    item_id: input.itemId,
    kind: input.kind,
    repo_id: input.repoId,
    actor_id: input.actorId,
    created_at: input.at ?? new Date().toISOString(),
  };
  db.query(
    `INSERT INTO interaction (id, viewer_id, item_id, kind, repo_id, actor_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    row.id,
    row.viewer_id,
    row.item_id,
    row.kind,
    row.repo_id,
    row.actor_id,
    row.created_at,
  );
  return toInteraction(row);
}

/** A viewer's newest interactions, newest first — the window affinity reads. */
export function listInteractions(
  db: Database,
  viewerId: string,
  limit = 1000,
): Interaction[] {
  return db
    .query<Row, [string, number]>(
      "SELECT * FROM interaction WHERE viewer_id = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .all(viewerId, limit)
    .map(toInteraction);
}

/** The repositories this viewer muted. Mute does not decay. */
export function mutedRepos(db: Database, viewerId: string): Set<string> {
  return new Set(
    db
      .query<{ repo_id: string }, [string]>(
        "SELECT DISTINCT repo_id FROM interaction WHERE viewer_id = ?1 AND kind = 'muted' AND repo_id IS NOT NULL",
      )
      .all(viewerId)
      .map((r) => r.repo_id),
  );
}

/** Mute one repository for this viewer; twice is the same as once. */
export function muteRepo(db: Database, viewerId: string, repoId: string): void {
  if (mutedRepos(db, viewerId).has(repoId)) return;
  recordInteraction(db, {
    viewerId,
    itemId: `repo:${repoId}`,
    kind: "muted",
    repoId,
    actorId: viewerId,
  });
}

/** Items this viewer dismissed. */
export function dismissedItems(db: Database, viewerId: string): Set<string> {
  return new Set(
    db
      .query<{ item_id: string }, [string]>(
        "SELECT DISTINCT item_id FROM interaction WHERE viewer_id = ?1 AND kind = 'dismissed'",
      )
      .all(viewerId)
      .map((r) => r.item_id),
  );
}

/**
 * When this viewer last opened, from their feed, an item whose id starts
 * with `prefix`; nothing when they never did.
 */
export function lastOpened(
  db: Database,
  viewerId: string,
  prefix: string,
): string | undefined {
  return (
    db
      .query<{ at: string | null }, [string, string, number]>(
        `SELECT MAX(created_at) AS at FROM interaction
          WHERE viewer_id = ?1 AND kind = 'opened'
            AND substr(item_id, 1, ?3) = ?2`,
      )
      .get(viewerId, prefix, prefix.length)?.at ?? undefined
  );
}

/**
 * The asks this viewer dismissed, each with when they last did. A dismissed
 * ask is not dismissed forever: it holds until something new happens to it
 * (`web/studio/asks.ts` compares this moment with the ask's own).
 */
export function askDismissals(
  db: Database,
  viewerId: string,
): Map<string, string> {
  return new Map(
    db
      .query<{ item_id: string; at: string }, [string]>(
        `SELECT item_id, MAX(created_at) AS at FROM interaction
         WHERE viewer_id = ?1 AND kind = 'dismissed' AND item_id LIKE 'ask:%'
         GROUP BY item_id`,
      )
      .all(viewerId)
      .map((r) => [r.item_id, r.at]),
  );
}

/**
 * Take back this viewer's dismissals of these items: an undo of a bulk
 * dismissal (`fleet/verbs.ts`). The one edit the table allows, and only of
 * the viewer's own rows.
 */
export function removeDismissals(
  db: Database,
  viewerId: string,
  itemIds: readonly string[],
): void {
  if (itemIds.length === 0) return;
  db.query<unknown, [string, string]>(
    `DELETE FROM interaction WHERE viewer_id = ?1 AND kind = 'dismissed'
       AND item_id IN (SELECT value FROM json_each(?2))`,
  ).run(viewerId, JSON.stringify(itemIds));
}

/**
 * Take back this viewer's bulk mutes of these `repo:<id>` items: the undo of
 * a bulk mute. A mute made elsewhere, under another item, stays.
 */
export function removeMutes(
  db: Database,
  viewerId: string,
  itemIds: readonly string[],
): void {
  if (itemIds.length === 0) return;
  db.query<unknown, [string, string]>(
    `DELETE FROM interaction WHERE viewer_id = ?1 AND kind = 'muted'
       AND item_id IN (SELECT value FROM json_each(?2))`,
  ).run(viewerId, JSON.stringify(itemIds));
}
