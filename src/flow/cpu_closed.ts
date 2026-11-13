/**
 * Pulls closed without merging after a check stopped for CPU (#11904): the
 * machine's failure, not the pull's, so a person can queue each again. A pull
 * counts when its last check — the queued retry the close itself cancelled
 * aside — was a CPU stop (`isCpuStop`) that ended in the window, and the pull
 * is closed and unmerged now. One query, walked from `run_kind_finished`
 * (kind, finished_at): the window's finished checks, newest close first. The
 * stop test (`isCpuStop`'s two forms) and the cap are both in the SQL, so a
 * load reads at most the cap's rows, not every failed close of the week.
 */

import type { Database } from "bun:sqlite";
import { CPU_STOP_SUMMARY } from "../core/runs.ts";
import { CPU_RED_LIKE } from "./cpu_stops.ts";

/** How far back a stop is looked for: a week of closes to re-queue. */
export const CPU_CLOSED_WINDOW_MS = 7 * 24 * 3_600_000;

/** At most this many pulls are listed. */
export const CPU_CLOSED_CAP = 20;

export interface CpuClosedPull {
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly closedAt: string;
}

/**
 * What the close itself writes on the checks it cancels (`checks/service.ts`): not the pull's
 * last word.
 */
const CLOSE_SUMMARIES = ["pull closed", "pull landed"] as const;

export function cpuClosedPulls(
  db: Database,
  now: Date,
  opts: { readonly cap?: number; readonly publicOnly?: boolean } = {},
): CpuClosedPull[] {
  const since = new Date(now.getTime() - CPU_CLOSED_WINDOW_MS).toISOString();
  const rows = db
    .query<{ repo: string; number: number; closed_at: string }, [string, string, string, string, string, string, number]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number, i.closed_at AS closed_at
         FROM run u
         JOIN issue i ON i.id = u.issue_id AND i.kind = 'pull' AND i.state = 'closed' AND i.closed_at <= ?5
         JOIN pull p ON p.issue_id = i.id AND p.merged_at IS NULL
         JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
        WHERE u.kind = 'check' AND u.finished_at IS NOT NULL AND u.finished_at >= ?1
          AND ((u.state = 'cancelled' AND u.summary = ?2) OR (u.state = 'failed' AND u.summary LIKE ?6))
          ${opts.publicOnly === true ? "AND r.visibility = 'public'" : ""}
          AND u.id = (SELECT n.id FROM run n WHERE n.issue_id = i.id AND n.kind = 'check'
                         AND NOT (n.state = 'cancelled' AND n.summary IN (?3, ?4))
                       ORDER BY n.id DESC LIMIT 1)
        ORDER BY i.closed_at DESC, i.number DESC
        LIMIT ?7`,
    )
    .all(since, CPU_STOP_SUMMARY, CLOSE_SUMMARIES[0], CLOSE_SUMMARIES[1], now.toISOString(), CPU_RED_LIKE, opts.cap ?? CPU_CLOSED_CAP);
  return rows.map((r) => ({ repo: r.repo, number: r.number, closedAt: r.closed_at }));
}
