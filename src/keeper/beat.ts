/**
 * The release tick's heartbeat (#11507): each time the tick runs it reports
 * what it did — cut, skipped and why, or failed and why — and the forge keeps
 * the last {@link KEPT} (#11794), so a quiet stretch can be told from a dead
 * keeper. The tick runs outside the forge's own judgment, so when it stops
 * this is the only trace; `release_keeper`, /releases and the terminal's
 * release keeper screen show it, and a beat older
 * than {@link SILENT_MS} is said plainly. Plain rows in, plain rows out.
 */

import type { Database } from "bun:sqlite";

export const OUTCOMES = ["cut", "skipped", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);

/** No heartbeat for this long is itself said. */
export const SILENT_MS = 60 * 60_000;
export const REASON_MAX = 300;
/** How many beats are kept; the oldest goes when one more is written. */
export const KEPT = 50;

export interface Beat {
  readonly at: string;
  readonly outcome: Outcome;
  readonly reason: string;
}

export function recordBeat(db: Database, outcome: Outcome, reason: string, at: Date = new Date()): Beat {
  const beat: Beat = { at: at.toISOString(), outcome, reason: reason.replace(/\s+/g, " ").trim().slice(0, REASON_MAX) };
  db.transaction(() => {
    db.query("INSERT INTO keeper_beat_tick (at, outcome, reason) VALUES (?1, ?2, ?3)").run(beat.at, beat.outcome, beat.reason);
    db.query("DELETE FROM keeper_beat_tick WHERE id <= (SELECT MAX(id) FROM keeper_beat_tick) - ?1").run(KEPT);
  })();
  return beat;
}

/** The newest beat, or null before the first. */
export function lastBeat(db: Database): Beat | null {
  return db.query<Beat, []>("SELECT at, outcome, reason FROM keeper_beat_tick ORDER BY id DESC LIMIT 1").get() ?? null;
}

/** What one tick did, as the keeper says it: the line and its outcome, never read back from the words. */
export interface Step {
  readonly line: string;
  readonly outcome: Outcome;
}

/** Run one tick and record its beat; a tick that throws is recorded as failed and the error goes on. */
export async function stepWithBeat(db: Database, step: () => Promise<Step>, now: () => Date = () => new Date()): Promise<string> {
  let done: Step;
  try {
    done = await step();
  } catch (error) {
    writeBeat(db, "failed", `step failed: ${error instanceof Error ? error.message : String(error)}`, now());
    throw error;
  }
  writeBeat(db, done.outcome, done.line, now());
  return done.line;
}

/** The beat is a trace, not the tick: a write that fails is said and never turns a good tick into a failed one. */
function writeBeat(db: Database, outcome: Outcome, reason: string, at: Date): void {
  try {
    recordBeat(db, outcome, reason, at);
  } catch (error) {
    console.error(`keeper heartbeat not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "never", "4 min ago", "2 h 5 min ago". */
export function agoWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

/** The heartbeat as one sentence, saying plainly when there is none or it is old. */
export function beatLine(beat: Beat | null, now: Date): string {
  if (beat === null) return "The release tick has never reported a heartbeat.";
  const age = now.getTime() - Date.parse(beat.at);
  const said = `The release tick last reported ${agoWords(age)} (${beat.outcome}): ${beat.reason}`;
  return age > SILENT_MS ? `No heartbeat from the release tick for ${agoWords(age).replace(" ago", "")}. ${said}` : said;
}

/** The heartbeat as a `dl` row's value: outcome, age and reason; "never reported" before the first. */
export function beatFact(beat: Beat | null, now: Date): string {
  if (beat === null) return "never reported";
  const age = now.getTime() - Date.parse(beat.at);
  return `${beat.outcome}, ${agoWords(age)}${age > SILENT_MS ? " (silent)" : ""}: ${beat.reason}`;
}
