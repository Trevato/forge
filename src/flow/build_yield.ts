/**
 * The crew's build yield over 24 hours (#6474): of the agent runs that
 * finished in the day before `now`, how many pushed, and how many of those
 * pulls landed or were closed unmerged. A run is a build run unless it was a
 * review. It pushed when a pull on its branch, in its repository, got a
 * `pull.pushed` or `pull.opened` event between the run's start and end.
 * `landed` and `closed` count those pulls, once each, as they stand now; a
 * pull still open is in neither. Same `publicOnly` rule as `readVitals`; one read.
 */

import type { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;

export interface BuildYield {
  readonly finished: number;
  readonly pushed: number;
  readonly landed: number;
  readonly closed: number;
}

interface Row {
  run_id: string;
  pull_id: string | null;
  merged: number | null;
  closed: number | null;
}

/**
 * `q.number + 0` drops the column's affinity so the event expression index
 * (`event_repo_kind_number_at`) applies: each run costs index lookups, never a scan of `event`.
 */
export const BUILD_YIELD_SQL = `SELECT x.id AS run_id, i.id AS pull_id, p.merged_at IS NOT NULL AS merged, i.state = 'closed' AS closed
         FROM run x JOIN repo r ON r.id = x.repo_id
         LEFT JOIN pull p ON x.branch != '' AND p.head_branch = x.branch
              AND EXISTS (SELECT 1 FROM issue q WHERE q.id = p.issue_id AND q.repo_id = x.repo_id)
              AND EXISTS (SELECT 1 FROM issue q JOIN event e ON e.repo_id = q.repo_id
                           WHERE q.id = p.issue_id AND e.kind IN ('pull.pushed', 'pull.opened')
                             AND json_extract(e.payload, '$.number') = q.number + 0
                             AND e.created_at >= x.started_at AND e.created_at <= x.finished_at)
         LEFT JOIN issue i ON i.id = p.issue_id
        WHERE x.kind = 'agent' AND x.reason != 'review' AND x.started_at IS NOT NULL
          AND x.finished_at >= ?1 AND x.finished_at <= ?2 AND (?3 = 0 OR r.visibility = 'public')`;

export function readBuildYield(db: Database, now = new Date(), publicOnly = false): BuildYield {
  const to = now.toISOString();
  const from = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = db
    .query<Row, [string, string, number]>(BUILD_YIELD_SQL)
    .all(from, to, publicOnly ? 1 : 0);
  const runs = new Set<string>();
  const pushed = new Set<string>();
  const landed = new Set<string>();
  const closed = new Set<string>();
  for (const row of rows) {
    runs.add(row.run_id);
    if (row.pull_id === null) continue;
    pushed.add(row.run_id);
    if (row.merged) landed.add(row.pull_id);
    else if (row.closed) closed.add(row.pull_id);
  }
  return { finished: runs.size, pushed: pushed.size, landed: landed.size, closed: closed.size };
}

/** The yield in words, for the page and the terminal alike. */
export function buildYieldSays(y: BuildYield): string {
  if (y.finished === 0) return "Build yield: no runs finished in the last 24 h.";
  return `Build yield: ${y.finished} ${y.finished === 1 ? "run" : "runs"} finished, ${y.pushed} pushed, ${y.landed} landed (24 h)`;
}
