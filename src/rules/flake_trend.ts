/**
 * The flake trend (#7560): the week's flaky tests from `check_flake`, ordered
 * by the gate minutes each cost. A flake costs the minutes of the check it
 * delayed: the gate's `duration_ms` when it failed in a gate, else the
 * check run's own. The worst three get an issue for the crew to build (the
 * same title the check's own filing uses, so one is never doubled). Quarantine
 * is not an option the issue offers: the fix is a deterministic or
 * budget-aware test.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import type { Repo } from "../core/repos.ts";
import { fileIssueOnce, flakeTitle } from "../checks/flake.ts";

export const WINDOW_MS = 7 * 24 * 3_600_000;
export const WORST = 3;

export interface Trend {
  readonly repoId: string;
  readonly repo: string;
  readonly test: string;
  readonly file: string;
  readonly count: number;
  /** Gate minutes the flakes delayed, one decimal. */
  readonly minutes: number;
}

/** The read behind the trend: `?1` = the week's start (ISO), `?2` = the row limit. */
export const FLAKE_TREND_SQL = `SELECT f.repo_id AS repoId, u.username || '/' || r.name AS repo, f.test AS test, MAX(f.file) AS file,
              COUNT(*) AS count,
              ROUND(SUM(COALESCE(
                (SELECT g.duration_ms FROM gate_result g WHERE g.run_id = f.run_id AND g.repo_id = f.repo_id LIMIT 1),
                (SELECT MAX(0, (julianday(c.finished_at) - julianday(c.started_at)) * 86400000) FROM run c WHERE c.id = f.run_id),
                0)) / 60000.0, 1) AS minutes
         FROM check_flake f
         JOIN repo r ON r.id = f.repo_id
         JOIN user u ON u.id = r.owner_id
        WHERE f.at >= ?1
        GROUP BY f.repo_id, f.test
        ORDER BY minutes DESC, count DESC, test
        LIMIT ?2`;

/** Most minutes first; then most flakes; then the name, so the order is whole. */
export function flakeTrend(db: Database, now: number, limit = 20): Trend[] {
  const rows = db
    .query<Trend, [string, number]>(FLAKE_TREND_SQL)
    .all(new Date(now - WINDOW_MS).toISOString(), limit);
  return rows;
}

/** The week's list as lines for a summary: `test ×n, m min (repo)`. */
export const trendLines = (list: readonly Trend[]): string[] => list.map((t) => `${t.test} ×${t.count}, ${t.minutes} min (${t.repo})`);

/** An ISO-ish label for the week `now` falls in: the Monday's date. */
export function weekOf(now: number): string {
  const d = new Date(now);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** An issue for each of the worst {@link WORST} that names a file; returns the numbers opened. */
export function fileWorst(db: Database, bus: EventBus, repos: ReadonlyMap<string, Pick<Repo, "id" | "ownerId">>, list: readonly Trend[]): number[] {
  const opened: number[] = [];
  for (const t of list.slice(0, WORST)) {
    const repo = repos.get(t.repoId);
    // No file, no "Files:" line to route it to a builder: no issue.
    if (repo === undefined || t.file === "") continue;
    const filed = fileIssueOnce(db, bus, repo, {
      title: flakeTitle(t.test),
      body:
        `_Filed by the rule watcher from the week's flake list, not written by a person._\n\n` +
        `\`${t.test}\` in \`${t.file}\` failed and passed alone ${t.count} time${t.count === 1 ? "" : "s"} this week, delaying checks by about ${t.minutes} minutes. ` +
        `It is among the three costliest flakes. Make it deterministic or budget-aware; quarantine is not allowed.\n\nFiles: ${t.file}`,
    });
    if (filed.opened) opened.push(filed.number);
  }
  return opened;
}
