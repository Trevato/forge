/** A maintenance duty's on/off switch (#11205): stored, set by a person or by three errors in a row; plain data in and out. */

import type { Database } from "bun:sqlite";
import { clip } from "./duty.ts";
import { duties as registered } from "./registry.ts";

/** Errored runs in a row that pause a duty. */
export const ERRORS_TO_PAUSE = 3;

export interface DutyState {
  readonly name: string;
  readonly paused: boolean;
  /** The row in words: the page, the API and the MCP say this. */
  readonly says: string;
  /** `says` without the name: what a row already headed by the name adds. */
  readonly detail: string;
}

interface Row { paused: number; reason: string; by: string; since: string; from_run: number }

const stateRow = (db: Database, name: string): Row | null =>
  db.query("SELECT paused, reason, by, since, from_run FROM maintenance_duty_state WHERE duty = ?1").get(name) as Row | null;

export const isPaused = (db: Database, name: string): boolean => stateRow(db, name)?.paused === 1;

/** A run that did not come out `ok`: it threw, timed out or had a finding refused. */
export const errored = (outcome: string): boolean => outcome !== "ok";

function put(db: Database, name: string, paused: boolean, reason: string, by: string, now: Date): void {
  const from = (db.query("SELECT COALESCE(MAX(id), 0) AS id FROM maintenance_run WHERE duty = ?1").get(name) as { id: number }).id;
  db.query(
    `INSERT INTO maintenance_duty_state (duty, paused, reason, by, since, from_run) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(duty) DO UPDATE SET paused = ?2, reason = ?3, by = ?4, since = ?5, from_run = CASE WHEN ?2 = 0 THEN ?6 ELSE from_run END`,
  ).run(name, paused ? 1 : 0, clip(reason), by, now.toISOString(), from);
}

export const setPaused = (db: Database, name: string, paused: boolean, by: string, now = new Date()): void =>
  put(db, name, paused, paused ? `paused by ${by}` : "", by, now);

/** After a run: three errored runs in a row (since the last resume) pause the duty, with the last error as the reason. Returns whether it paused. */
export function pauseOnErrors(db: Database, name: string, now = new Date()): boolean {
  const from = stateRow(db, name)?.from_run ?? 0;
  const rows = db.query("SELECT outcome FROM maintenance_run WHERE duty = ?1 AND id > ?2 ORDER BY id DESC LIMIT ?3").all(name, from, ERRORS_TO_PAUSE) as { outcome: string }[];
  if (rows.length < ERRORS_TO_PAUSE || !rows.every((r) => errored(r.outcome))) return false;
  put(db, name, true, `paused after ${ERRORS_TO_PAUSE} errors in a row; last error: ${rows[0]!.outcome}`, "the runner", now);
  return true;
}

export function dutyState(db: Database, name: string): DutyState {
  const s = stateRow(db, name);
  if (s?.paused === 1) {
    const detail = `paused since ${s.since.slice(0, 16).replace("T", " ")} UTC; ${s.reason}`;
    return { name, paused: true, says: `${name}: ${detail}.`, detail };
  }
  const last = db.query("SELECT outcome FROM maintenance_run WHERE duty = ?1 ORDER BY id DESC LIMIT 1").get(name) as { outcome: string } | null;
  const detail = `on${last && errored(last.outcome) ? `; last run errored: ${last.outcome}` : ""}`;
  return { name, paused: false, says: `${name}: ${detail}.`, detail };
}

export const dutyStates = (db: Database): DutyState[] => registered.map((d) => dutyState(db, d.name));

export const knownDuty = (name: string): boolean => registered.some((d) => d.name === name);

/** One switch for page, API and MCP: the same words. */
export function switchDuty(db: Database, name: unknown, paused: unknown, by: string): { ok: true; says: string } | { ok: false; code: "invalid" | "not_found"; says: string } {
  if (typeof name !== "string" || !knownDuty(name)) return { ok: false, code: "not_found", says: "No such maintenance duty." };
  if (typeof paused !== "boolean") return { ok: false, code: "invalid", says: "paused is true or false." };
  setPaused(db, name, paused, by);
  return { ok: true, says: paused ? `${name} is paused.` : `${name} is on again.` };
}
