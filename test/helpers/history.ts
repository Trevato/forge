/**
 * Give an app a history (#10299): a new app that has not run shows only its
 * progress, so a test of the full page first has the crew take one run there.
 * The run is finished, so it is history and not work in flight.
 */
import type { Database } from "bun:sqlite";
import { createRun, finishRun } from "../../src/core/runs.ts";

export function giveHistory(db: Database, repoId: string): void {
  const run = createRun(db, { repoId, kind: "agent", reason: "history" });
  finishRun(db, run.id, { state: "ok", summary: "done" });
}

/** Make an app older than the window that counts as new, so its page is the full one. */
export function ageApp(db: Database, repoId: string): void {
  db.run("UPDATE app SET created_at = '2026-01-02T00:00:00.000Z' WHERE repo_id = ?1", [repoId]);
}
