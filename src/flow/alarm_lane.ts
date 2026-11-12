/**
 * The "lane has stopped" flow alarm (#11507). On 2026-11-12 nothing merged for
 * 12 h 51 min and nothing said so: main was not ahead of production, so the
 * main-ahead alarm stayed quiet, and every check was being stopped for CPU.
 * Two states raise this one alarm for the forge's own repository:
 *
 * - the lane has stopped: pulls are open or work is ready, the crew is not
 *   at its ceiling, and nothing has merged for `flow.lane_minutes` (90);
 * - one cause fails many pulls: the same failure line (numbers masked) failed
 *   checks on {@link FORGE_PULLS} different pulls within an hour. That is the
 *   forge's failure, not the builders': `forgeFailed` is what the crew asks
 *   before it reworks or parks a pull for it.
 *
 * A failure line is the first line of a check's summary, for a check that
 * named no failing test (a stop for CPU, a budget, a lost machine); a named
 * test is `checks/shared_red.ts`'s. Pure of the clock.
 */

import type { Database } from "bun:sqlite";
import { spentTodayEverywhere } from "../crew/autonomy.ts";
import type { Run } from "../core/runs.ts";
import { getRepo } from "../core/repos.ts";
import { agoWords } from "../keeper/beat.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { ceilingReached } from "./ceiling.ts";
import { readPipeline } from "./pipeline.ts";

export const LANE_SETTING = "flow.lane_minutes";
export const LANE_DEFAULT_MIN = 90;
/** Different pulls failing one line within {@link FORGE_WINDOW_MS} make it the forge's. */
export const FORGE_PULLS = 5;
export const FORGE_WINDOW_MS = 3_600_000;
const LINE_MAX = 200;

export interface LaneAlarm {
  readonly fired: boolean;
  /** When the lane last merged, or the first failure of the shared line; set when fired. */
  readonly since?: string;
  readonly says: string;
  /** The commonest failure line, verbatim, when one exists. */
  readonly line?: string | undefined;
  /** Whether one cause is failing many pulls. */
  readonly forge?: boolean;
  readonly facts?: readonly string[];
}

/** The minutes without a merge before the alarm; a whole number from 1 to 10080 is the owner's, else 90. */
export function laneMinutes(db: Database): number {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(LANE_SETTING);
  const n = row === null ? NaN : Number(row.value);
  return Number.isInteger(n) && n >= 1 && n <= 10_080 ? n : LANE_DEFAULT_MIN;
}

/** The same line with every number as `#`, so `16.0 cores for 30s` and `15.2 cores for 31s` are one cause. */
export const maskLine = (line: string): string => line.replace(/\d+(?:\.\d+)?/g, "#");

interface Failure {
  readonly issue: string;
  readonly at: string;
  readonly line: string;
}

/** A check's failure line, or "" when it named a failing test (not this alarm's) or said nothing. */
function lineOf(summary: string, detail: string): string {
  try {
    const names = (JSON.parse(detail) as { names?: unknown } | null)?.names;
    if (Array.isArray(names) && names.length > 0) return "";
  } catch {
    // An unreadable detail names no test.
  }
  const first = summary.trim().split("\n")[0] ?? "";
  return first.replace(/^check failed: /, "").slice(0, LINE_MAX);
}

/** Failed pull checks of the repository finished since `since`, newest first, bounded. */
function failuresSince(db: Database, repoId: string, since: string): Failure[] {
  return db
    .query<{ issue_id: string | null; finished_at: string; summary: string; check_detail: string }, [string, string]>(
      `SELECT issue_id, finished_at, summary, check_detail FROM run
        WHERE repo_id = ?1 AND kind = 'check' AND state = 'failed' AND finished_at >= ?2
        ORDER BY finished_at DESC LIMIT 2000`,
    )
    .all(repoId, since)
    .map((r) => ({ issue: r.issue_id ?? "", at: r.finished_at, line: lineOf(r.summary, r.check_detail) }));
}

interface Group {
  readonly masked: string;
  /** The newest instance, verbatim. */
  readonly line: string;
  count: number;
  readonly pulls: Set<string>;
  since: string;
}

function groups(failures: readonly Failure[]): Group[] {
  const by = new Map<string, Group>();
  for (const f of failures) {
    if (f.line === "") continue;
    const m = maskLine(f.line);
    const g = by.get(m) ?? { masked: m, line: f.line, count: 0, pulls: new Set<string>(), since: f.at };
    g.count++;
    if (f.issue !== "") g.pulls.add(f.issue);
    if (f.at < g.since) g.since = f.at;
    by.set(m, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || (a.masked < b.masked ? -1 : 1));
}

/** When a pull of the repository last merged. */
function lastMerge(db: Database, repoId: string): string | null {
  return (
    db
      .query<{ at: string | null }, [string]>(`SELECT MAX(p.merged_at) AS at FROM pull p JOIN issue i ON i.id = p.issue_id WHERE i.repo_id = ?1`)
      .get(repoId)?.at ?? null
  );
}

/** The failure lines that failed {@link FORGE_PULLS} pulls' checks within the hour and since the last merge (a merge proves the lane): the forge's own. */
function forgeGroups(db: Database, repoId: string, now: number): Group[] {
  const hour = new Date(now - FORGE_WINDOW_MS).toISOString();
  const merged = lastMerge(db, repoId);
  const since = merged !== null && merged > hour ? merged : hour;
  return groups(failuresSince(db, repoId, since)).filter((g) => g.pulls.size >= FORGE_PULLS);
}

/** The masked forge lines per repository, read once per sweep: a sweep asks {@link forgeFailed} for every pull. */
export type ForgeLines = Map<string, ReadonlySet<string>>;

/** Whether this failed check's line is one the forge failed on many pulls: the crew neither reworks nor parks for it. */
export function forgeFailed(db: Database, run: Run | undefined, now: number, memo?: ForgeLines): boolean {
  if (run === undefined || run.kind !== "check" || run.state !== "failed") return false;
  const line = lineOf(run.summary, run.checkDetail === null || run.checkDetail === undefined ? "{}" : JSON.stringify(run.checkDetail));
  if (line === "") return false;
  let lines = memo?.get(run.repoId);
  if (lines === undefined) {
    lines = new Set(forgeGroups(db, run.repoId, now).map((g) => g.masked));
    memo?.set(run.repoId, lines);
  }
  return lines.has(maskLine(line));
}

function ownRepoId(db: Database): string | undefined {
  const [owner, name] = ownRepoPath().split("/");
  return owner && name ? getRepo(db, owner, name)?.id : undefined;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function laneAlarm(db: Database, now: Date, forge: { readonly ceilingUsd: number | null } = { ceilingUsd: null }): LaneAlarm {
  const quiet = { fired: false, says: "Pulls are landing, or there is nothing to land, or the crew is paused on purpose." } as const;
  const repoId = ownRepoId(db);
  if (repoId === undefined) return quiet;
  const at = now.getTime();
  const shared = forgeGroups(db, repoId, at)[0];
  const last = lastMerge(db, repoId);
  const open = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'pull' AND state = 'open'`)
    .get(repoId)?.n ?? 0;
  const limit = laneMinutes(db) * 60_000;
  let stopped = false;
  let wait = 0;
  if (last !== null && (at - Date.parse(last) > limit)) {
    wait = at - Date.parse(last);
    const ready = open > 0 ? open : (readPipeline(db, now).find((s) => s.key === "ready")?.waiting ?? 0);
    stopped = ready > 0 && !ceilingReached(spentTodayEverywhere(db, now), forge.ceilingUsd);
  }
  if (!stopped && shared === undefined) return quiet;

  const parts: string[] = [];
  const facts: string[] = [];
  let line: string | undefined;
  let since: string;
  if (stopped) {
    const failed = failuresSince(db, repoId, last!);
    const top = groups(failed)[0];
    line = top?.line;
    since = last!;
    parts.push(
      `Nothing has merged for ${agoWords(wait).replace(" ago", "")} (since ${last}) with ${count(open, "pull")} open; ${failed.length} ${failed.length === 1 ? "check" : "checks"} failed in that span` +
        (top === undefined ? "." : `, ${top.count} of them with: ${top.line}`),
    );
    facts.push(`last merge at ${last}`, `${count(open, "pull")} open`, `${failed.length} checks failed since the last merge`);
    if (top !== undefined) facts.push(`commonest failure, ${top.count} times: ${top.line}`);
  } else since = shared!.since;
  if (shared !== undefined) {
    line = line ?? shared.line;
    if (stopped && shared.masked !== maskLine(line)) facts.push(`failed ${count(shared.pulls.size, "pull")} within the hour: ${shared.line}`);
    parts.push(
      `One cause is failing ${count(shared.pulls.size, "pull")} within the hour: ${shared.line}. That is the forge's failure, not the builders': their reworks and parks for it are held`,
    );
    facts.push(`forge failure on ${count(shared.pulls.size, "pull")} within the hour since ${shared.since}: ${shared.line}`);
  }
  return { fired: true, since, says: `${parts.join(". ")}.`.replace(/\.\.$/, "."), line, forge: shared !== undefined, facts };
}
