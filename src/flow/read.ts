/**
 * The flow of one repository, read from the records the forge already keeps:
 * issues, pulls, the checks at each head, reviews, and production deploys.
 * Folds them into `FlowIssue`s for the pure `flowStage`; adds no state.
 */

import type { Database } from "bun:sqlite";
import { getIssuesByIds, LIST_LIMIT_MAX, listIssues, type Issue } from "../core/issues.ts";
import { closesFromBody, joinMany, listPulls, type Pull } from "../core/pulls.ts";
import { listReviews, reviewSummariesFor, reviewSummary } from "../core/reviews.ts";
import type { Repo } from "../core/repos.ts";
import { checksForHeads, verdictForHead, type Run } from "../core/runs.ts";
import {
  flowStage,
  type FlowChecks,
  type FlowIssue,
  type FlowPull,
  type FlowStage,
} from "./stage.ts";

const DAY = 24 * 60 * 60 * 1000;
/** A merge older than this is history, not a candidate for "just went live". */
const MERGE_WINDOW = 7 * DAY;

export interface FlowOptions {
  readonly now: Date;
  /** Passed to the issue and pull lists: which sealed rows the viewer may see. */
  readonly scope: { sealed?: true; sealedBy?: string };
}

export interface Flow {
  /** Every open issue, and merged ones production has not yet served (`land`). */
  readonly open: FlowStage[];
  /** Went live in the last 24 hours, newest first. */
  readonly live: (FlowStage & { liveAt: string })[];
}

function foldChecks(db: Database, pull: Pull): FlowChecks {
  return foldRuns(verdictForHead(db, pull.id, pull.headOid));
}

/** The newest run of each kind at one head, folded to one state. */
export function foldRuns(
  runs: readonly { state: string; createdAt: string; finishedAt: string | null }[],
): FlowChecks {
  if (runs.length === 0) return { state: "none", at: null };
  const stamp = (r: (typeof runs)[number]) => r.finishedAt ?? r.createdAt;
  const newest = (pick: readonly (typeof runs)[number][]) =>
    pick.map(stamp).reduce((a, b) => (b > a ? b : a));
  const bad = runs.filter((r) => r.state === "failed" || r.state === "cancelled");
  if (bad.length > 0) return { state: "failed", at: newest(bad) };
  const waiting = runs.filter((r) => r.state !== "ok");
  if (waiting.length > 0) return { state: "running", at: newest(waiting) };
  return { state: "ok", at: newest(runs) };
}

/** The latest time each pull was re-opened, by number — `created_at` is only the first open. */
function reopenedAt(db: Database, repoId: string): Map<number, string> {
  const out = new Map<number, string>();
  const rows = db
    .query<{ payload: string; created_at: string }, [string]>(
      "SELECT payload, created_at FROM event WHERE repo_id = ?1 AND kind = 'pull.reopened' ORDER BY id",
    )
    .all(repoId);
  for (const row of rows) {
    try {
      const n = (JSON.parse(row.payload) as { number?: unknown }).number;
      if (typeof n === "number") out.set(n, row.created_at);
    } catch {
      // a payload that is not JSON names no pull
    }
  }
  return out;
}

/** Production deploys, oldest first, from `since` on. */
function productionDeploys(db: Database, repoId: string, since: string) {
  return db
    .query<{ state: string; finished_at: string | null; created_at: string }, [string, string]>(
      `SELECT state, finished_at, created_at FROM run
        WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production' AND created_at >= ?2
        ORDER BY id`,
    )
    .all(repoId, since);
}

type Scope = FlowOptions["scope"];

/** Every open issue or pull, newest first: the list's pages followed to the end, not its cap. */
function allOpen(db: Database, repoId: string, scope: Scope, kind: "issue" | "pull"): Issue[] | Pull[] {
  const out: (Issue | Pull)[] = [];
  let cursor: number | undefined;
  for (;;) {
    const options = { ...scope, state: "open" as const, limit: LIST_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) };
    const page: (Issue | Pull)[] =
      kind === "issue" ? listIssues(db, repoId, options) : listPulls(db, repoId, options);
    out.push(...page);
    if (page.length < LIST_LIMIT_MAX) return out as Issue[] | Pull[];
    cursor = page[page.length - 1]!.number;
  }
}

/** The SQL that keeps sealed rows from a viewer who may not see them; `at` is the next parameter's number. */
function sealedClause(scope: Scope, alias: string, at: number): { sql: string; params: string[] } {
  if (scope.sealed === true) return { sql: "", params: [] };
  if (scope.sealedBy === undefined) return { sql: ` AND ${alias}.sealed = 0`, params: [] };
  return {
    sql: ` AND (${alias}.sealed = 0 OR ${alias}.author_id = ?${at})`,
    params: [scope.sealedBy],
  };
}

/**
 * Closed issues or pulls of `kind` that closed at or after `since` — chosen by
 * the time window, not by a newest-N cap — under the viewer's sealed scope.
 */
function closedSince(db: Database, repoId: string, scope: Scope, kind: "issue" | "pull", since: string): Issue[] {
  const seal = sealedClause(scope, "issue", 4);
  const params = [repoId, kind, since, ...seal.params];
  const ids = db
    .query<{ id: string }, string[]>(
      `SELECT issue.id FROM issue
        WHERE issue.repo_id = ?1 AND issue.kind = ?2 AND issue.state = 'closed' AND issue.closed_at >= ?3${seal.sql}`,
    )
    .all(...params)
    .map((r) => r.id);
  return [...getIssuesByIds(db, ids).values()].sort((a, b) => b.number - a.number);
}

export function readFlow(
  db: Database,
  repo: Repo,
  options: FlowOptions,
): Flow {
  const { now, scope } = options;
  const repoId = repo.id;
  const { requireReview } = repo;
  const reopened = reopenedAt(db, repoId);
  const windowStart = new Date(now.getTime() - MERGE_WINDOW).toISOString();
  // Every open pull, plus those closed or merged inside the window.
  const pulls = [
    ...(allOpen(db, repoId, scope, "pull") as Pull[]),
    ...joinMany(db, closedSince(db, repoId, scope, "pull", windowStart)),
  ];
  const deploys = productionDeploys(db, repoId, windowStart);

  const toFlowPull = (pull: Pull): FlowPull => {
    const merged = pull.mergedAt;
    const after = merged === null ? [] : deploys.filter((d) => d.created_at >= merged);
    const served = after.find((d) => d.state === "ok" && d.finished_at !== null);
    const last = after[after.length - 1];
    const summary =
      pull.state === "open" ? reviewSummary(db, pull.id, pull.headOid) : undefined;
    const verdicts = summary
      ? listReviews(db, pull.id).filter((r) => r.commitOid === pull.headOid && r.state !== "commented")
      : [];
    return {
      number: pull.number,
      state: pull.state,
      openedAt: reopened.get(pull.number) ?? pull.createdAt,
      closedAt: pull.closedAt,
      mergedAt: merged,
      checks: pull.state === "open" ? foldChecks(db, pull) : { state: "none", at: null },
      approvals: summary?.approvals ?? 0,
      changesRequested: summary?.changesRequested ?? 0,
      requireReview,
      reviewedAt: verdicts.length ? verdicts.map((r) => r.createdAt).reduce((a, b) => (b > a ? b : a)) : null,
      liveAt: served?.finished_at ?? null,
      deployFailed: served === undefined && last !== undefined && last.state === "failed",
    };
  };

  // Pulls by the issue they close. A merge older than the window cannot be news.
  const byIssue = new Map<number, FlowPull[]>();
  for (const pull of pulls) {
    if (pull.mergedAt !== null && pull.mergedAt < windowStart) continue;
    const flowPull = toFlowPull(pull);
    for (const n of closesFromBody(pull.body)) {
      const list = byIssue.get(n) ?? [];
      list.push(flowPull);
      byIssue.set(n, list);
    }
  }

  const open = allOpen(db, repoId, scope, "issue") as Issue[];
  const cutoff = new Date(now.getTime() - DAY).toISOString();
  const candidates = new Map<string, Issue>(open.map((i) => [i.id, i]));
  for (const closed of closedSince(db, repoId, scope, "issue", windowStart))
    candidates.set(closed.id, closed);

  const blockers = openBlockers(db, scope, [...candidates.keys()]);
  const build = (issue: Issue): FlowIssue => ({
    number: issue.number,
    title: issue.title,
    createdAt: issue.createdAt,
    assignee: issue.assigneeName,
    blockedBy: blockers.get(issue.id) ?? [],
    pulls: byIssue.get(issue.number) ?? [],
  });

  const out: Flow = { open: [], live: [] };
  for (const issue of open) out.open.push(flowStage(build(issue), now));
  for (const issue of candidates.values()) {
    if (issue.state !== "closed") continue;
    const stage = flowStage(build(issue), now);
    // Merged and closed, not yet served by production: still in the flow.
    if (stage.stage === "land") out.open.push(stage);
    const liveAt = stage.stage === "live" ? stage.since : null;
    if (liveAt !== null && liveAt >= cutoff) out.live.push({ ...stage, liveAt });
  }
  out.live.sort((a, b) => (a.liveAt < b.liveAt ? 1 : -1));
  return out;
}

/** The numbers of the open issues each of these waits for, that the viewer may see. */
function openBlockers(
  db: Database,
  scope: Scope,
  ids: readonly string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const seal = sealedClause(scope, "b", 1);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const at = seal.params.length;
    const rows = db
      .query<{ issue_id: string; number: number }, string[]>(
        `SELECT d.issue_id, b.number FROM issue_dependency d
         JOIN issue b ON b.id = d.blocked_by_id
         WHERE b.state = 'open'${seal.sql} AND d.issue_id IN (${chunk.map((_, n) => `?${at + n + 1}`).join(",")})
         ORDER BY b.number`,
      )
      .all(...seal.params, ...chunk);
    for (const row of rows) out.set(row.issue_id, [...(out.get(row.issue_id) ?? []), row.number]);
  }
  return out;
}

/**
 * The stage of each issue an open pull closes, by issue number: the lean read
 * for a list that only needs to say building, checking or in review (#11619).
 * The furthest-along pull speaks for the issue, as in `flowStage`.
 */
export function openPullStages(db: Database, repo: Repo, scope: Scope, now: Date, only?: ReadonlySet<number>): Map<number, FlowStage["stage"]> {
  const out = new Map<number, FlowStage["stage"]>();
  // One statement for all open pulls; a repository with none costs nothing more.
  const seal = sealedClause(scope, "issue", 2);
  const pulls = db
    .query<{ id: string; body: string; head_oid: string; created_at: string; number: number }, string[]>(
      `SELECT issue.id, issue.number, issue.body, issue.created_at, pull.head_oid FROM issue
         JOIN pull ON pull.issue_id = issue.id
        WHERE issue.repo_id = ?1 AND issue.kind = 'pull' AND issue.state = 'open'${seal.sql}`,
    )
    .all(repo.id, ...seal.params);
  const asked = pulls
    .map((pull) => ({ pull, closes: closesFromBody(pull.body).filter((n) => only === undefined || only.has(n)) }))
    .filter((p) => p.closes.length > 0); // a pull that closes nothing asked about costs nothing
  if (asked.length === 0) return out;
  // Two reads for all of them, not two per pull.
  const runs = checksForHeads(db, new Map(asked.map((p) => [p.pull.id, p.pull.head_oid])));
  const reviews = reviewSummariesFor(db, asked.map((p) => ({ id: p.pull.id, headOid: p.pull.head_oid })));
  for (const { pull, closes } of asked) {
    const summary = reviews.get(pull.id);
    const flowPull: FlowPull = {
      number: pull.number,
      state: "open",
      openedAt: pull.created_at,
      closedAt: null,
      mergedAt: null,
      checks: foldRuns(newestPerKind(runs.get(pull.id) ?? [])),
      approvals: summary?.approvals ?? 0,
      changesRequested: summary?.changesRequested ?? 0,
      requireReview: repo.requireReview,
      reviewedAt: null,
      liveAt: null,
      deployFailed: false,
    };
    for (const n of closes) {
      const stage = flowStage({ number: n, title: "", createdAt: pull.created_at, assignee: null, blockedBy: [], pulls: [flowPull] }, now).stage;
      const seen = out.get(n);
      if (seen === undefined || STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(seen)) out.set(n, stage);
    }
  }
  return out;
}
/** `verdictForHead` over runs already read, newest first: the newest of each kind and environment. */
function newestPerKind(runs: readonly Run[]): Run[] {
  const newest = new Map<string, Run>();
  for (const run of runs) if (!newest.has(`${run.kind}:${run.env}`)) newest.set(`${run.kind}:${run.env}`, run);
  return [...newest.values()];
}
const STAGE_ORDER = ["issue", "pull", "check", "review", "land", "live"] as const;
