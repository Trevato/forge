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

export const isInteractionKind = (v: unknown): v is InteractionKind =>
  typeof v === "string" && (INTERACTION_KINDS as readonly string[]).includes(v);

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
