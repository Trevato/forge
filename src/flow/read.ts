/**
 * The flow of one repository, read from the records the forge already keeps:
 * issues, pulls, the checks at each head, reviews, and production deploys.
 * Folds them into `FlowIssue`s for the pure `flowStage`; adds no state.
 */

import type { Database } from "bun:sqlite";
import { listIssues, type Issue } from "../core/issues.ts";
import { closesFromBody, listPulls, type Pull } from "../core/pulls.ts";
import { listReviews, reviewSummary } from "../core/reviews.ts";
import type { Repo } from "../core/repos.ts";
import { verdictForHead } from "../core/runs.ts";
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
  readonly open: FlowStage[];
  /** Went live in the last 24 hours, newest first. */
  readonly live: (FlowStage & { liveAt: string })[];
}

function foldChecks(db: Database, pull: Pull): FlowChecks {
  const runs = verdictForHead(db, pull.id, pull.headOid);
  if (runs.length === 0) return { state: "none", at: null };
  const stamp = (r: (typeof runs)[number]) => r.finishedAt ?? r.createdAt;
  const newest = (pick: typeof runs) =>
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

export function readFlow(
  db: Database,
  repo: Repo,
  options: FlowOptions,
): Flow {
  const { now, scope } = options;
  const repoId = repo.id;
  const { requireReview } = repo;
  const reopened = reopenedAt(db, repoId);
  const pulls = listPulls(db, repoId, { ...scope, state: "all", limit: 200 });
  const windowStart = new Date(now.getTime() - MERGE_WINDOW).toISOString();
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

  const open = listIssues(db, repoId, { ...scope, state: "open", limit: 200 });
  const cutoff = new Date(now.getTime() - DAY).toISOString();
  const candidates = new Map<string, Issue>(open.map((i) => [i.id, i]));
  for (const closed of listIssues(db, repoId, { ...scope, state: "closed", limit: 200 }))
    if (closed.closedAt !== null && closed.closedAt >= windowStart) candidates.set(closed.id, closed);

  const blockers = openBlockers(db, [...candidates.keys()]);
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
    const liveAt = stage.stage === "live" ? stage.since : null;
    if (liveAt !== null && liveAt >= cutoff) out.live.push({ ...stage, liveAt });
  }
  out.live.sort((a, b) => (a.liveAt < b.liveAt ? 1 : -1));
  return out;
}

/** The numbers of the open issues each of these waits for. */
function openBlockers(db: Database, ids: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .query<{ issue_id: string; number: number }, string[]>(
        `SELECT d.issue_id, b.number FROM issue_dependency d
         JOIN issue b ON b.id = d.blocked_by_id
         WHERE b.state = 'open' AND d.issue_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY b.number`,
      )
      .all(...chunk);
    for (const row of rows) out.set(row.issue_id, [...(out.get(row.issue_id) ?? []), row.number]);
  }
  return out;
}
