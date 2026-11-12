/**
 * What the governor last did (#6520): a pure step over its readings that
 * remembers the last change of slot count, and the words for it. The first
 * reading is recorded with from === to (a baseline, not a change).
 */

import type { Database } from "bun:sqlite";
import type { Governed } from "./governor.ts";

export interface GovernorLast {
  readonly from: number;
  readonly to: number;
  readonly why: string;
  /** Epoch milliseconds of the change. */
  readonly at: number;
}

/** `prev` in, the new `last` out; `changed` only when the slot count moved. */
export function governorStep(
  prev: GovernorLast | null,
  governed: Governed,
  now: number,
): { last: GovernorLast; changed: boolean } {
  if (!prev) return { last: { from: governed.slots, to: governed.slots, why: governed.why, at: now }, changed: false };
  if (prev.to === governed.slots) return { last: prev, changed: false };
  return { last: { from: prev.to, to: governed.slots, why: governed.why, at: now }, changed: true };
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** "Builders 7 → 3 at 20:41: <why>" or "Builders back to 7 at 21:30" (UTC); empty before any change. */
export function governorSays(last: GovernorLast | null): string {
  if (!last || last.from === last.to) return "";
  if (last.to > last.from) return `Builders back to ${last.to} at ${clock(last.at)}`;
  return `Builders ${last.from} → ${last.to} at ${clock(last.at)}: ${last.why}`;
}

interface Row { from_slots: number; to_slots: number; why: string; at: number }

/** The remembered last change for a repository (kept in the app's sqlite file), or null before any reading. */
export function readLast(db: Database, repoId: string): GovernorLast | null {
  const r = db.query("SELECT from_slots, to_slots, why, at FROM governor_last WHERE repo_id = ?1").get(repoId) as Row | null;
  return r ? { from: r.from_slots, to: r.to_slots, why: r.why, at: r.at } : null;
}

/** Feeds one reading through `governorStep` and keeps the result; the line that says it. */
export function rememberGovernor(db: Database, repoId: string, governed: Governed, now: number): GovernorLast {
  const prev = readLast(db, repoId);
  const { last } = governorStep(prev, governed, now);
  if (last !== prev)
    db.query(
      "INSERT INTO governor_last (repo_id, from_slots, to_slots, why, at) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(repo_id) DO UPDATE SET from_slots = ?2, to_slots = ?3, why = ?4, at = ?5",
    ).run(repoId, last.from, last.to, last.why, last.at);
  return last;
}
