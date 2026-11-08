/**
 * What the clog watch knows, for a person (#6757): the clog standing now and
 * the note of the last one cleared, as plain lines. The reader is the owner's
 * alone (`clog.*` is an admins' event); a page or screen that shows these
 * lines gates on that before it calls.
 */

import type { Database } from "bun:sqlite";
import { duration } from "./clog_note.ts";
import { lastClearedNote, loadClog } from "./clog_tick.ts";

export interface ClogRead {
  readonly standing: { readonly since: number; readonly startedAt: number; readonly reasons: readonly string[] } | null;
  /** The last cleared note within a day, on one line. */
  readonly last: string | null;
}

export function readClog(db: Database, now = new Date()): ClogRead {
  const state = loadClog(db);
  return {
    standing: state ? { since: state.since, startedAt: state.startedAt ?? state.since, reasons: state.firstReasons } : null,
    last: lastClearedNote(db, now) ?? null,
  };
}

/** "Clogged for 2.5 h (noticed 12 min in): <cause>." and the last cleared note, one line each; none, no lines. */
export function clogLines(read: ClogRead, now: number): string[] {
  const out: string[] = [];
  if (read.standing) {
    const s = read.standing;
    const cause = s.reasons.length ? s.reasons.join("; ") : "cause not recorded";
    const lag = s.since > s.startedAt ? ` (noticed ${duration(s.since - s.startedAt)} in)` : "";
    out.push(`Clogged for ${duration(now - s.startedAt)}${lag}: ${cause}.`);
  }
  if (read.last) out.push(read.last);
  return out;
}
