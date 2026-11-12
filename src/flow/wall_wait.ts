/**
 * A pull the access wall holds (#7847): green, maybe approved, and waiting
 * for a person to allow the new access or send it back. The crew's land
 * sweep writes a `land` decision answered "wall" for the head it stopped
 * on; this reads it, so every place that says who acts next says the same.
 */

import type { Database } from "bun:sqlite";
import { latestDecision, type Decision } from "../core/decisions.ts";

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];

/** What the wall holds `headOid` for, in plain words; null when it holds nothing there. */
export function wallWords(db: Database, pullId: string, headOid: string): string[] | null {
  return wallWordsOf(latestDecision(db, pullId, "land"), headOid);
}

/** `wallWords` from the pull's latest `land` decision, already read: a list reads them all at once. */
export function wallWordsOf(d: Decision | undefined, headOid: string): string[] | null {
  if (d === undefined || d.answer !== "wall" || d.outcome !== null) return null;
  const state = d.state as { head?: unknown; plain?: unknown; cells?: unknown } | null;
  if (state === null || typeof state !== "object" || state.head !== headOid) return null;
  const said = strings(state.plain);
  return said.length > 0 ? said : strings(state.cells);
}

/** The sentence a person reads: what is new, and what they may do. */
export const wallAsk = (words: readonly string[]): string =>
  `the access wall holds it for a person to decide: ${words.join("; ")}. Allow it (merge) or send it back`;
