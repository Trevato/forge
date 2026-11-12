/**
 * Stuck pulls (#7556): approved, open, no run or review event for 30 minutes, and not
 * landable. Green on its head and approved is queue wait, not stuck (as `alarm_stuck.ts`).
 */

import type { Database } from "bun:sqlite";
import { lastEvent, STUCK_MINUTES } from "../../flow/alarm_stuck.ts";
import { checkOn, nameOf, type KPull } from "./pulls.ts";

export interface Stuck {
  readonly pull: KPull;
  /** Why it cannot land. */
  readonly why: "conflicted" | "red" | "unchecked";
  readonly quietMs: number;
}

export function stuckPulls(db: Database, now: Date, pulls: readonly KPull[], conflicted: ReadonlySet<string>): Stuck[] {
  const out: Stuck[] = [];
  for (const pull of pulls) {
    if (!pull.approved || pull.hold !== undefined) continue;
    const check = checkOn(db, pull);
    const isConflicted = conflicted.has(nameOf(pull));
    if (check?.state === "ok" && !isConflicted) continue;
    const last = lastEvent(db, { id: pull.id, repo_id: pull.repoId, head_repo_id: pull.headRepoId, head_branch: pull.headBranch });
    if (last === undefined) continue;
    const quietMs = now.getTime() - Date.parse(last.at);
    if (quietMs < STUCK_MINUTES * 60_000) continue;
    out.push({ pull, why: isConflicted ? "conflicted" : check?.state === "failed" ? "red" : "unchecked", quietMs });
  }
  return out.sort((a, b) => b.quietMs - a.quietMs);
}
