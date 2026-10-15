/**
 * Where a thought went (#652). The planner writes one placement per
 * thought, once: its kind, what it did on the map, and the reply that
 * shows under the thought in the feed. The thought itself is never touched.
 */

import type { Database } from "bun:sqlite";

export const KINDS = ["work", "amendment", "vision", "decision", "reversal"] as const;
export type Kind = (typeof KINDS)[number];

export type Action = "opened" | "amended" | "deferred" | "superseded" | "linked";

/** One thing done on the map: an issue of `repo` (owner/name), and the pillar it serves. */
export interface Placed {
  action: Action;
  repo: string;
  number: number;
  pillar?: string;
}

export interface Placement {
  thoughtId: string;
  kind: Kind;
  placed: Placed[];
  /** One or two lines; with a short question when the thought was ambiguous. */
  reply: string;
  asked: boolean;
  decidedBy: string;
  placedAt: string;
}

interface Row {
  thought_id: string;
  kind: string;
  placed: string;
  reply: string;
  question: number;
  decided_by: string;
  placed_at: string;
}

export function savePlacement(db: Database, p: Placement): void {
  db.query(
    "INSERT OR IGNORE INTO placement (thought_id, kind, placed, reply, question, decided_by, placed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).run(p.thoughtId, p.kind, JSON.stringify(p.placed), p.reply, p.asked ? 1 : 0, p.decidedBy, p.placedAt);
}

function toPlacement(r: Row): Placement {
  return {
    thoughtId: r.thought_id,
    kind: r.kind as Kind,
    placed: JSON.parse(r.placed) as Placed[],
    reply: r.reply,
    asked: r.question === 1,
    decidedBy: r.decided_by,
    placedAt: r.placed_at,
  };
}

export function placementOf(db: Database, thoughtId: string): Placement | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM placement WHERE thought_id = ?1").get(thoughtId);
  return row ? toPlacement(row) : undefined;
}

export function placementsOf(db: Database, thoughtIds: readonly string[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const id of thoughtIds) {
    const p = placementOf(db, id);
    if (p) out.set(id, p);
  }
  return out;
}

/** The thought as MCP and the API show it: the placement, or `null` while it waits. */
export function placementJson(p: Placement | undefined): Record<string, unknown> | null {
  return p
    ? { kind: p.kind, placed: p.placed, reply: p.reply, asked: p.asked, decidedBy: p.decidedBy, placedAt: p.placedAt }
    : null;
}

/** Thoughts of one author with no placement yet, received at or after `since`, oldest first. */
export function unplaced(db: Database, authorId: string, since: string, limit: number): { id: string; text: string; receivedAt: string }[] {
  return db
    .query<{ id: string; text: string; received_at: string }, [string, string, number]>(
      `SELECT t.id, t.text, t.received_at FROM thought t
        WHERE t.author = ?1 AND t.received_at >= ?2
          AND NOT EXISTS (SELECT 1 FROM placement p WHERE p.thought_id = t.id)
        ORDER BY t.received_at, t.id LIMIT ?3`,
    )
    .all(authorId, since, limit)
    .map((r) => ({ id: r.id, text: r.text, receivedAt: r.received_at }));
}

/** Authors with a thought at or after `since` that has no placement yet. */
export function authorsWithUnplaced(db: Database, since: string): string[] {
  return db
    .query<{ author: string }, [string]>(
      `SELECT DISTINCT t.author FROM thought t
        WHERE t.received_at >= ?1 AND NOT EXISTS (SELECT 1 FROM placement p WHERE p.thought_id = t.id)`,
    )
    .all(since)
    .map((r) => r.author);
}

/** A thought's author, when it exists. */
export function thoughtAuthor(db: Database, thoughtId: string): string | undefined {
  return db.query<{ author: string }, [string]>("SELECT author FROM thought WHERE id = ?1").get(thoughtId)?.author;
}
