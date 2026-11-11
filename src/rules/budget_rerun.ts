/**
 * Budget tests under load (#7560): a test that holds a speed and failed in a
 * full run, then passed when run alone, three times in a week has no headroom
 * under the gate's load. One issue per such test, with the p95 of the failed
 * attempts' measured times (`check_flake.ms`); #7354 is the first of its kind.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import type { Repo } from "../core/repos.ts";
import { fileIssueOnce } from "../checks/flake.ts";

export const WINDOW_MS = 7 * 24 * 3_600_000;
export const FILE_AT = 3;

/**
 * A test whose name says it holds a speed: the word budget, a percentile, or
 * "under"/"within" a stated time. A bare "N ms" or "answers in" is not enough:
 * plenty of tests mention a time without being held to one.
 */
export const BUDGET_NAME = /\b(budget|p9[059]|(under|within) \d[\d_.]* ?m?s)\b/i;

export interface BudgetRerun {
  readonly repoId: string;
  readonly test: string;
  readonly file: string;
  readonly passes: number;
  /** Nearest-rank p95 of the attempts' ms; undefined when none was measured. */
  readonly p95Ms: number | undefined;
}

export function p95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

/** The read behind the budget rows: `?1` = the week's start (ISO); names are then filtered by {@link BUDGET_NAME}. */
export const BUDGET_SQL = "SELECT repo_id, test, file, ms FROM check_flake WHERE at >= ?1 ORDER BY at";

export function budgetReruns(db: Database, now: number): BudgetRerun[] {
  const rows = db
    .query<{ repo_id: string; test: string; file: string; ms: number | null }, [string]>(BUDGET_SQL)
    .all(new Date(now - WINDOW_MS).toISOString());
  const by = new Map<string, { repoId: string; test: string; file: string; passes: number; ms: number[] }>();
  for (const r of rows) {
    if (!BUDGET_NAME.test(r.test)) continue;
    const key = `${r.repo_id}\0${r.test}`;
    const at = by.get(key) ?? { repoId: r.repo_id, test: r.test, file: r.file, passes: 0, ms: [] };
    at.passes += 1;
    if (r.file !== "") at.file = r.file;
    if (r.ms !== null) at.ms.push(r.ms);
    by.set(key, at);
  }
  return [...by.values()].map((b) => ({ repoId: b.repoId, test: b.test, file: b.file, passes: b.passes, p95Ms: p95(b.ms) }));
}

export const headroomTitle = (test: string): string => `Budget headroom: ${test.slice(0, 200)}`;

/** One headroom issue per budget test re-run green {@link FILE_AT} times in the week; returns the numbers opened. */
export function fileHeadroom(db: Database, bus: EventBus, repos: ReadonlyMap<string, Pick<Repo, "id" | "ownerId">>, now: number): number[] {
  const opened: number[] = [];
  for (const b of budgetReruns(db, now)) {
    const repo = repos.get(b.repoId);
    if (repo === undefined || b.passes < FILE_AT || b.file === "") continue;
    const filed = fileIssueOnce(db, bus, repo, {
      title: headroomTitle(b.test),
      body:
        `_Filed by the rule watcher from the flake record, not written by a person._\n\n` +
        `\`${b.test}\` in \`${b.file}\` failed in a full run and passed when re-run alone ${b.passes} times this week: ` +
        `its budget leaves no headroom under the gate's load (see #7354). ` +
        `Measured p95 of the failed attempts: ${b.p95Ms === undefined ? "not measured (older rows carry no time)" : `${b.p95Ms} ms`}.\n\n` +
        `Count work instead of milliseconds (\`expectWork\`), or give the budget room above that p95; do not quarantine it.\n\nFiles: ${b.file}`,
    });
    if (filed.opened) opened.push(filed.number);
  }
  return opened;
}
