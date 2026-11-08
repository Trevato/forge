/**
 * The gate minutes (#6426, a flow vital of #5930): check-slot minutes spent
 * over the last hour and the last 6 h, on the merge queue's gates
 * (`checks/queue.ts`, traced in `check_gate` by `checks/gate_record.ts`) and
 * on every other check (`run` rows of kind `check`: a pull's, and a branch's
 * after a push or a land).
 *
 * Each check counts only its minutes inside the window:
 *
 *   minutes = Σ max(0, min(end, now) − max(start, now − window)) / 60 000 ms
 *
 * where `end` is when it finished, or `now` while it runs. A gate row a
 * crashed forge left open ends at `start + GATE_DEADLINE_MS`, the most a gate
 * may hold its slot. A check not yet started (`queued`) holds no slot and
 * counts nothing. One read; forge-wide for the owner, public repositories
 * alone for an agent — the rule `readVitals` keeps.
 */

import type { Database } from "bun:sqlite";
import { GATE_DEADLINE_MS } from "../checks/queue.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface GateMinutes {
  readonly gate1h: number;
  readonly gate6h: number;
  readonly pull1h: number;
  readonly pull6h: number;
}

/** Milliseconds of [start, end] inside [?from, ?3], per row; `end` already says what an open row ends at. */
const clipped = (start: string, end: string, from: string): string =>
  `MAX(0, MIN(julianday(${end}), julianday(?3)) - MAX(julianday(${start}), julianday(${from}))) * ${DAY_MS}`;

const GATE_END = "COALESCE(g.finished_at, MIN(julianday(?3), julianday(g.started_at) + ?5))";
const RUN_END = "COALESCE(c.finished_at, ?3)";

const gateSum = (from: string): string =>
  `(SELECT COALESCE(SUM(${clipped("g.started_at", GATE_END, from)}), 0)
      FROM check_gate g JOIN repo r ON r.id = g.repo_id
     WHERE (?4 = 0 OR r.visibility = 'public')
       AND g.started_at < ?3 AND (g.finished_at IS NULL OR g.finished_at > ${from}))`;

const runSum = (from: string): string =>
  `(SELECT COALESCE(SUM(${clipped("c.started_at", RUN_END, from)}), 0)
      FROM run c JOIN repo r ON r.id = c.repo_id
     WHERE (?4 = 0 OR r.visibility = 'public') AND c.kind = 'check'
       AND c.started_at IS NOT NULL AND c.started_at < ?3
       AND (c.finished_at IS NULL OR c.finished_at > ${from}))`;

/** Minutes to one decimal: the reading is a vital, not an invoice. */
const minutes = (ms: number | undefined): number => Math.round((ms ?? 0) / 6_000) / 10;

/** `publicOnly` counts public repositories alone, for a reader who must not learn what private ones hold. */
export function readGateMinutes(db: Database, now = new Date(), publicOnly = false): GateMinutes {
  const to = now.toISOString();
  const h1 = new Date(now.getTime() - HOUR_MS).toISOString();
  const h6 = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
  const row = db
    .query<Record<keyof GateMinutes, number>, [string, string, string, number, number]>(
      `SELECT ${gateSum("?1")} AS gate1h, ${gateSum("?2")} AS gate6h,
              ${runSum("?1")} AS pull1h, ${runSum("?2")} AS pull6h`,
    )
    .get(h1, h6, to, publicOnly ? 1 : 0, GATE_DEADLINE_MS / DAY_MS);
  return {
    gate1h: minutes(row?.gate1h),
    gate6h: minutes(row?.gate6h),
    pull1h: minutes(row?.pull1h),
    pull6h: minutes(row?.pull6h),
  };
}
