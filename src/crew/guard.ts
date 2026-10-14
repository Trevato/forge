/**
 * Runs the crew can already see are waste (#807). Two rules, both asked
 * before a run is queued, neither a model call:
 *
 * - A follow-up with nothing new (`news.ts`) is skipped: the agent would
 *   read its own reply as the newest word and decline, at full price. So
 *   is the clock giving the planner the direction again when nobody spoke
 *   and the map has not moved since its last pass.
 * - An issue that has started `issueRunCap` runs inside a day since a
 *   person who may direct the crew last spoke is capped: parked with one
 *   note, raised as one ask, and given nothing more until that person
 *   speaks. A loop is a question, not a retry.
 *
 * Each skip and each cap is a row in the decision ledger (kind `guard`,
 * by `rule`), so what the guard saved can be counted (`guardCounts`).
 */

import type { Database } from "bun:sqlite";
import type { Agent } from "../core/agents.ts";
import { recordDecision } from "../core/decisions.ts";
import type { Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { directorsAmong } from "./direct.ts";
import { nothingNew, plannerNothingNew } from "./news.ts";

/** Runs one issue may start in `CAP_WINDOW_MS` unless the setting says otherwise. */
export const ISSUE_RUN_CAP = 6;
export const CAP_WINDOW_MS = 24 * 60 * 60_000;

/** The note a capped issue is parked with: the map reads it as `parked`, the asks as a question. */
export const CAP_NOTE =
  "Parked by the crew: this issue started its day's share of runs without landing, so nothing more starts here until a person says what to try.";

/** What a skipped follow-up records, and what its run says when one was already queued. */
export const SKIP_SUMMARY = "skipped: nothing new to act on since the last run";

/** A follow-up for `agent` on `issue` that would find nothing new: skip it. */
export function skipsFeedback(
  db: Database,
  repo: Repo,
  issue: Issue,
  agent: Agent,
): boolean {
  if (!nothingNew(db, repo, issue, agent)) return false;
  recordDecision(db, {
    kind: "guard",
    repoId: repo.id,
    issueId: issue.id,
    state: { reason: "feedback", agent: agent.user.username },
    answer: "skipped",
    p: 1,
    by: "rule",
    ms: 0,
  });
  return true;
}

/**
 * The clock giving `planner` the direction again with nothing new since its
 * last pass (`plannerNothingNew`): skip it. The clock asks every minute, so
 * one skip is recorded per pass, the first time it is asked after `since`.
 */
export function skipsReplan(
  db: Database,
  repo: Repo,
  direction: Issue,
  planner: Agent,
  since: string,
): boolean {
  if (!plannerNothingNew(db, repo, direction, planner)) return false;
  const recorded = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM decision
        WHERE issue_id = ?1 AND kind = 'guard' AND answer = 'skipped'
          AND state LIKE '%"reason":"replan"%' AND created_at > ?2`,
    )
    .get(direction.id, since);
  if ((recorded?.n ?? 0) === 0)
    recordDecision(db, {
      kind: "guard",
      repoId: repo.id,
      issueId: direction.id,
      state: { reason: "replan", agent: planner.user.username },
      answer: "skipped",
      p: 1,
      by: "rule",
      ms: 0,
    });
  return true;
}

/**
 * Whether `issue` has started `cap` runs inside the window since a person
 * who may direct the crew last spoke on it. A run a restart or the
 * provider cut short, a resumed run and a skipped one are not new starts.
 */
export function capReached(
  db: Database,
  repo: Repo,
  issue: Issue,
  cap: number,
  now = new Date(),
): boolean {
  const from = new Date(now.getTime() - CAP_WINDOW_MS).toISOString();
  const spoke = db
    .query<{ id: string; at: string }, [string, string]>(
      `SELECT author_id AS id, MAX(created_at) AS at FROM comment
        WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL
          AND body NOT LIKE 'Parked by the crew%'
        GROUP BY author_id`,
    )
    .all(issue.id, from);
  const directors = new Set(
    directorsAmong(
      db,
      repo,
      spoke.map((s) => s.id),
    ),
  );
  const since = spoke
    .filter((s) => directors.has(s.id))
    .map((s) => s.at)
    .reduce((a, b) => (a > b ? a : b), from);
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM run
        WHERE issue_id = ?1 AND kind = 'agent' AND created_at > ?2
          AND attempt = 0
          AND summary NOT LIKE 'interrupted: %'
          AND summary NOT LIKE 'skipped: %'`,
    )
    .get(issue.id, since);
  return (row?.n ?? 0) >= cap;
}

/** Record that `issue` was capped: once per park, beside the note. */
export function recordCap(
  db: Database,
  repo: Repo,
  issue: Issue,
  cap: number,
): void {
  recordDecision(db, {
    kind: "guard",
    repoId: repo.id,
    issueId: issue.id,
    state: { cap, windowHours: CAP_WINDOW_MS / 3_600_000 },
    answer: "capped",
    p: 1,
    by: "rule",
    ms: 0,
  });
}

export interface GuardCounts {
  /** Follow-ups not started: nothing new to act on. */
  readonly skipped: number;
  /** Issues parked at their run cap. */
  readonly capped: number;
}

/** What the guard did on a repository since `since`: the token-return view's numbers. */
export function guardCounts(
  db: Database,
  repoId: string,
  since: string,
): GuardCounts {
  const rows = db
    .query<{ answer: string; n: number }, [string, string]>(
      `SELECT answer, COUNT(*) AS n FROM decision
        WHERE repo_id = ?1 AND kind = 'guard' AND created_at >= ?2
        GROUP BY answer`,
    )
    .all(repoId, since);
  const of = (answer: string): number =>
    rows.find((r) => r.answer === answer)?.n ?? 0;
  return { skipped: of("skipped"), capped: of("capped") };
}
