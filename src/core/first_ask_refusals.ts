/**
 * Refused first asks (#11525): one row each with who asked, the first
 * `ASK_CHARS` characters and the refusal's words. At most `PER_ACTOR_HOUR`
 * rows per actor per hour (the next is dropped silently); rows older than
 * `KEEP_MS` are pruned on write. Never holds a claim code, token or email.
 */

import type { Database } from "bun:sqlite";

/** How many refusals a reader sees. */
export const REFUSED_SHOWN = 20;
export const ASK_CHARS = 200;
export const PER_ACTOR_HOUR = 20;
export const KEEP_MS = 30 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;

/** Who may read the refusals: a forge admin who is a person. The page, its link on /system and the terminal all ask this. */
export const mayReadRefusals = (user: { isAdmin: boolean; kind?: string } | null | undefined): boolean =>
  user?.isAdmin === true && user.kind !== "agent";

export interface Refusal {
  readonly id: number;
  readonly at: number;
  readonly actorId: string | null;
  readonly ask: string;
  readonly words: string;
}

export interface NewRefusal {
  readonly actorId: string | null;
  readonly ask: string;
  readonly words: string;
}

/** Keep one refusal; returns whether a row was written. */
export function recordRefusal(db: Database, r: NewRefusal, now: number): boolean {
  db.query("DELETE FROM first_ask_refusals WHERE at < ?1").run(now - KEEP_MS);
  const recent = db
    .query("SELECT COUNT(*) AS n FROM first_ask_refusals WHERE actor_id IS ?1 AND at > ?2")
    .get(r.actorId, now - HOUR_MS) as { n: number };
  if (recent.n >= PER_ACTOR_HOUR) return false;
  db.query("INSERT INTO first_ask_refusals (at, actor_id, ask, words) VALUES (?1, ?2, ?3, ?4)").run(
    now,
    r.actorId,
    r.ask.slice(0, ASK_CHARS),
    r.words,
  );
  return true;
}

/** The newest refusals first, at most `limit` (1 to 500), none older than `KEEP_MS` before `now`. */
export function listRefusals(db: Database, limit: number, now: number): Refusal[] {
  const n = Math.min(500, Math.max(1, Math.trunc(limit) || 1));
  const rows = db
    .query("SELECT id, at, actor_id, ask, words FROM first_ask_refusals WHERE at >= ?2 ORDER BY at DESC, id DESC LIMIT ?1")
    .all(n, now - KEEP_MS) as { id: number; at: number; actor_id: string | null; ask: string; words: string }[];
  return rows.map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, ask: r.ask, words: r.words }));
}

/** How many refusals are kept (none older than `KEEP_MS`): one COUNT, never the list. */
export function countRefusals(db: Database, now: number): number {
  return (db.query("SELECT COUNT(*) AS n FROM first_ask_refusals WHERE at >= ?1").get(now - KEEP_MS) as { n: number }).n;
}
