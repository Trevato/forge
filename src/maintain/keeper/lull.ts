/**
 * Lulls (#7556): builders idle while startable issues exist, or checks idle while pulls wait,
 * two samples in a row. The first such sample pair writes one `keeper_lull` start event naming
 * the cause, in the words home's builders tile uses (`crew/idle_reason.ts`); the first sample
 * after writes one end event. Nothing is written while nothing is startable.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../../app.ts";
import { listCrewRoles } from "../../core/agents.ts";
import { listAutonomousRepos } from "../../core/repos.ts";
import { listActive } from "../../core/runs.ts";
import { slottedRuns } from "../../crew/autonomy.ts";
import { heldNow } from "../../crew/held.ts";
import { whatBlocks } from "../../crew/idle_reason.ts";
import { checkOn, type KPull } from "./pulls.ts";
import { note } from "./record.ts";

export type LullKind = "builders" | "checks";

export interface Reading {
  readonly kind: LullKind;
  /** Work waits and nothing is taking it. */
  readonly idle: boolean;
  /** How much waits; the probe's number. */
  readonly waiting: number;
  /** Why, in the builders tile's words; read only when idle. */
  readonly cause: string;
}

/** Samples in a row that make a lull. */
export const SAMPLES = 2;

/** Per database: consecutive idle samples by kind (a restart forgets them; a lull is then seen two samples later). */
const streaks = new WeakMap<Database, Map<LullKind, number>>();

/** The builders' reading: startable issues that no builder is taking, in the autonomous repositories with a crew. */
export function readBuilders(app: App, now: Date): Reading {
  let waiting = 0;
  let idle = false;
  let cause = "no cause found";
  for (const repo of listAutonomousRepos(app.db)) {
    if (repo.autonomy !== "autonomous" || repo.autonomyBy === null || repo.archivedAt !== null) continue;
    const crew = listCrewRoles(app.db, repo.id);
    if (crew.length === 0) continue;
    const held = heldNow(app, repo);
    const startable = held.startable.length;
    if (startable === 0) continue;
    waiting += startable;
    const active = listActive(app.db, "agent").filter((r) => r.repoId === repo.id);
    if (slottedRuns(active, crew).length >= repo.autonomySlots) continue;
    if (!idle) {
      idle = true;
      cause = whatBlocks(app, repo, now)?.word ?? (held.by.hot_file.length > 0 ? "hot file" : "no cause found");
    }
  }
  return { kind: "builders", idle, waiting, cause };
}

/** The checks' reading: open pulls with no check on their head while no check or deploy is queued or running. */
export function readChecks(db: Database, pulls: readonly KPull[]): Reading {
  const waiting = pulls.filter((p) => p.hold === undefined && checkOn(db, p) === undefined).length;
  const busy = listActive(db, "check").length + listActive(db, "deploy").length;
  return { kind: "checks", idle: waiting > 0 && busy === 0, waiting, cause: "no check is queued or running" };
}

/** Whether the last lull event of this kind began one that has not ended. */
export function lullOpen(db: Database, kind: LullKind): boolean {
  const last = db
    .query<{ phase: string | null }, [string]>(
      `SELECT json_extract(payload, '$.phase') AS phase FROM event
        WHERE kind = 'keeper_lull' AND json_extract(payload, '$.lull') = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(kind);
  return last?.phase === "start";
}

/** One sample in; the line to report when it wrote an event, else undefined. */
export function sample(db: Database, reading: Reading): string | undefined {
  let mine = streaks.get(db);
  if (mine === undefined) streaks.set(db, (mine = new Map()));
  const open = lullOpen(db, reading.kind);
  if (!reading.idle) {
    mine.set(reading.kind, 0);
    if (!open) return undefined;
    note(db, "keeper_lull", undefined, { lull: reading.kind, phase: "end", waiting: reading.waiting });
    return `${reading.kind} lull ended`;
  }
  const streak = (mine.get(reading.kind) ?? 0) + 1;
  mine.set(reading.kind, streak);
  if (streak < SAMPLES || open) return undefined;
  note(db, "keeper_lull", undefined, { lull: reading.kind, phase: "start", cause: reading.cause, waiting: reading.waiting });
  return `${reading.kind} lull began: ${reading.cause}`;
}
