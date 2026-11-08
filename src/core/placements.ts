/**
 * Where a thought went (#652). The planner writes one placement per
 * thought, once: its kind, what it did on the map, and the reply that
 * shows under the thought in the feed. The thought itself is never touched.
 */

import type { Database } from "bun:sqlite";

export const KINDS = ["work", "amendment", "vision", "decision", "reversal"] as const;
export type Kind = (typeof KINDS)[number];

export type Action = "opened" | "amended" | "deferred" | "superseded" | "linked" | "proposed";

/** One thing done on the map: an issue of `repo` (owner/name), and the pillar it serves. */
export interface Placed {
  action: Action;
  repo: string;
  number: number;
  pillar?: string;
  /** For `proposed`: `number` is a pull of `repo`, and this is its number again. It marks a vision pull. */
  pull?: number;
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

/** Add what a person's overrule did to a placement (#8696); what the planner wrote stays as it was. */
export function appendPlaced(db: Database, thoughtId: string, more: readonly Placed[]): void {
  const now = placementOf(db, thoughtId);
  if (!now) return;
  db.query("UPDATE placement SET placed = ?2 WHERE thought_id = ?1").run(thoughtId, JSON.stringify([...now.placed, ...more]));
}

export function placementOf(db: Database, thoughtId: string): Placement | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM placement WHERE thought_id = ?1").get(thoughtId);
  return row ? toPlacement(row) : undefined;
}

/** Whether a placement of kind `vision` proposed pull `number` of `repo` (owner/name): the one mark of a vision pull. */
export function isVisionPull(db: Database, repo: string, number: number): boolean {
  const rows = db
    .query<Row, [string]>("SELECT * FROM placement WHERE kind = 'vision' AND placed LIKE ?1")
    .all(`%"pull":${number}%`);
  return rows.some((r) => toPlacement(r).placed.some((p) => p.action === "proposed" && p.repo === repo && p.pull === number));
}

/** The placements of these thoughts: one query per chunk, never one per thought (#7509). */
export function placementsOf(db: Database, thoughtIds: readonly string[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const unique = [...new Set(thoughtIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, string[]>(`SELECT * FROM placement WHERE thought_id IN (${batch.map(() => "?").join(",")})`)
      .all(...batch);
    for (const r of rows) out.set(r.thought_id, toPlacement(r));
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
