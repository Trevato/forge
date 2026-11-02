/**
 * The "idle crew" flow alarm (#5930): work is ready, the spend ceiling is not
 * reached, and no agent run has started for 15 minutes. Plain data in, plain
 * data out; nothing reads the clock, `now` is passed in. Nothing draws it yet.
 */

import type { Database } from "bun:sqlite";
import { spentTodayEverywhere } from "../crew/autonomy.ts";
import { ceilingReached } from "./ceiling.ts";
import { readPipeline, span } from "./pipeline.ts";

export const IDLE_CREW_MS = 15 * 60_000;

export interface IdleCrewAlarm {
  readonly fired: boolean;
  /** When the crew last started a run (or, with none, when the oldest ready issue began waiting); set when fired. */
  readonly since?: string;
  readonly says: string;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function alarmIdleCrew(
  db: Database,
  now: Date,
  forge: { readonly ceilingUsd: number | null } = { ceilingUsd: null },
): IdleCrewAlarm {
  const ready = readPipeline(db, now).find((s) => s.key === "ready");
  const waiting = ready?.waiting ?? 0;
  if (waiting === 0) return { fired: false, says: "No issue is ready, so the crew has nothing to start." };
  if (ceilingReached(spentTodayEverywhere(db, now), forge.ceilingUsd)) {
    return { fired: false, says: "The spend ceiling is reached, so the crew is paused on purpose." };
  }
  const last = db
    .query<{ at: string | null }, []>(
      `SELECT MAX(COALESCE(started_at, created_at)) AS at FROM run WHERE kind = 'agent'`,
    )
    .get()?.at ?? null;
  const since = last ?? ready?.oldestWaiting ?? null;
  const idle = since === null ? 0 : now.getTime() - Date.parse(since);
  if (since === null || !(idle >= IDLE_CREW_MS)) {
    return { fired: false, says: `${count(waiting, "issue")} ready, and a crew run started within 15 min.` };
  }
  return {
    fired: true,
    since,
    says: `${count(waiting, "issue")} ${waiting === 1 ? "is" : "are"} ready and no crew run has started for ${span(idle)}.`,
  };
}
