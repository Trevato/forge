/**
 * The stalled steps a viewer can unblock, for the home's cards: open pulls
 * in repositories they may write to whose check has not been asked for, or
 * failed, for longer than the stage allows. Three reads however many
 * stall — the repositories, the pulls, the newest run of each kind at each
 * head — folded by the same pure `flowStage` the flow page uses.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../core/pulls.ts";
import { listReposWritableTo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { foldRuns } from "./read.ts";
import { flowStage, type Stage } from "./stage.ts";

const REPOS_MAX = 100;

export interface StalledStep {
  readonly repo: string;
  readonly ownerName: string;
  readonly repoName: string;
  readonly pull: number;
  readonly title: string;
  /** The issue the pull closes, when it says so. */
  readonly issue: number | null;
  readonly stage: Stage;
  readonly since: string;
  readonly unblock: string;
  /** `run` asks for a check; `rerun` asks again after a red. */
  readonly action: "run" | "rerun";
}

interface PullRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  created_at: string;
  head_oid: string;
}
interface RunRow {
  issue_id: string;
  kind: string;
  env: string;
  state: string;
  created_at: string;
  finished_at: string | null;
}

export function readStalled(db: Database, viewer: User, now: Date): StalledStep[] {
  const repos = listReposWritableTo(db, viewer, {
    limit: REPOS_MAX,
    withoutArchived: true,
  });
  if (repos.length === 0) return [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const ids = [...byId.keys()];
  const marks = (from: number) => ids.map((_, i) => `?${from + i}`).join(",");
  const pulls = db
    .query<PullRow, string[]>(
      `SELECT issue.id, issue.repo_id, issue.number, issue.title, issue.body, issue.created_at, pull.head_oid
         FROM issue JOIN pull ON pull.issue_id = issue.id
        WHERE issue.kind = 'pull' AND issue.state = 'open' AND pull.merged_at IS NULL
          AND (issue.sealed = 0 OR issue.author_id = ?1) AND issue.repo_id IN (${marks(2)})`,
    )
    .all(viewer.id, ...ids);
  if (pulls.length === 0) return [];
  // Newest run first; the first of each kind and environment is the verdict.
  const runs = new Map<string, RunRow[]>();
  const seen = new Set<string>();
  const rows = db
    .query<RunRow, string[]>(
      `SELECT run.issue_id, run.kind, run.env, run.state, run.created_at, run.finished_at
         FROM run JOIN pull ON pull.issue_id = run.issue_id AND pull.head_oid = run.commit_oid
         JOIN issue ON issue.id = pull.issue_id
        WHERE run.kind IN ('deploy','check') AND issue.kind = 'pull' AND issue.state = 'open'
          AND pull.merged_at IS NULL AND run.repo_id IN (${marks(1)}) ORDER BY run.id DESC`,
    )
    .all(...ids);
  for (const r of rows) {
    const key = `${r.issue_id}:${r.kind}:${r.env}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.set(r.issue_id, [...(runs.get(r.issue_id) ?? []), r]);
  }
  const out: StalledStep[] = [];
  for (const p of pulls) {
    const repo = byId.get(p.repo_id);
    if (repo === undefined) continue;
    const checks = foldRuns(
      (runs.get(p.id) ?? []).map((r) => ({
        state: r.state,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      })),
    );
    const step = flowStage(
      {
        number: p.number,
        title: p.title,
        createdAt: p.created_at,
        assignee: null,
        blockedBy: [],
        pulls: [
          {
            number: p.number,
            state: "open",
            openedAt: p.created_at,
            closedAt: null,
            mergedAt: null,
            checks,
            approvals: 0,
            changesRequested: 0,
            requireReview: repo.requireReview,
            reviewedAt: null,
            liveAt: null,
            deployFailed: false,
          },
        ],
      },
      now,
    );
    if (!step.stalled || (checks.state !== "none" && checks.state !== "failed")) continue;
    out.push({
      repo: repo.id,
      ownerName: repo.ownerName,
      repoName: repo.name,
      pull: p.number,
      title: p.title,
      issue: closesFromBody(p.body)[0] ?? null,
      stage: step.stage,
      since: step.since,
      unblock: step.unblock,
      action: checks.state === "failed" ? "rerun" : "run",
    });
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : 1));
}
