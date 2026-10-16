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
 *   speaks. A loop is a question, not a retry. The direction issue is not
 *   one issue retried but the planner's standing one: it is paced
 *   (`autonomy.ts`) and bounded by its own, generous `directionRunCap`.
 *
 * Each skip and each cap is a row in the decision ledger (kind `guard`,
 * by `rule`), so what the guard saved can be counted (`guardCounts`).
 */

import type { Database } from "bun:sqlite";
import type { Agent } from "../core/agents.ts";
import { recordDecision } from "../core/decisions.ts";
import type { Issue } from "../core/issues.ts";
import { listPulls } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { directorsAmong } from "./direct.ts";
import { nothingNew, plannerNothingNew } from "./news.ts";

/** Runs one issue may start in `CAP_WINDOW_MS` unless the setting says otherwise. */
export const ISSUE_RUN_CAP = 6;
export const CAP_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Planning passes the direction issue may start in `CAP_WINDOW_MS` unless
 * the setting says otherwise. Generous: the planner is already paced by the
 * replan floor, the breaker, its hold and the dollar ceiling (#2143).
 */
export const DIRECTION_RUN_CAP = 48;

/** The run cap that applies to `issue`: the direction's own, or the issue cap. */
export function runCapOf(
  repo: Repo,
  issue: Issue,
  caps: { readonly issueRunCap?: number; readonly directionRunCap?: number },
): number {
  return issue.id === repo.directionIssueId
    ? (caps.directionRunCap ?? DIRECTION_RUN_CAP)
    : (caps.issueRunCap ?? ISSUE_RUN_CAP);
}

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
 * Where the cap's count starts on `issue`: a day ago, or the last word of a
 * person who may direct the crew if that is later. The park note itself is
 * no one's word, whoever's name it carries.
 */
function capFrom(db: Database, repo: Repo, issue: Issue, now: Date): string {
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
  return spoke
    .filter((s) => directors.has(s.id))
    .map((s) => s.at)
    .reduce((a, b) => (a > b ? a : b), from);
}

/**
 * Whether `issue` has started `cap` runs inside the window since a person
 * who may direct the crew last spoke on it. A run a restart or the
 * provider cut short, a resumed run and a skipped one are not new starts;
 * nor is a reviewer's run on a pull, which only answers a push the counted
 * runs made and is bounded by the hand-over (`HANDOVER_ROUNDS`). Nor is a
 * run bringing a pull up to a main that moved, or answering its red check:
 * neither is the agent going round, and both already have their own bound
 * (`CHECK_FAILED_LIMIT` over `automaticRunsSince`), which parks or releases
 * the pull itself — counted here too, they parked pulls that were working.
 */
export function capReached(
  db: Database,
  repo: Repo,
  issue: Issue,
  cap: number,
  now = new Date(),
): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM run
        WHERE issue_id = ?1 AND kind = 'agent' AND created_at > ?2
          AND attempt = 0
          AND reason NOT IN ('review', 'conflict', 'check_failed')
          AND summary NOT LIKE 'interrupted: %'
          AND summary NOT LIKE 'skipped: %'`,
    )
    .get(issue.id, capFrom(db, repo, issue, now));
  return (row?.n ?? 0) >= cap;
}

/**
 * Whether `issue` already carries the cap's note inside the cap's window:
 * parked, and asked about, once. Words after the note — a review, a reader —
 * do not make it a second park; only a director's word starts a new window.
 */
export function capNoted(
  db: Database,
  repo: Repo,
  issue: Issue,
  now = new Date(),
): boolean {
  return (
    db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM comment
          WHERE issue_id = ?1 AND body = ?2 AND created_at >= ?3 LIMIT 1`,
      )
      .get(issue.id, CAP_NOTE, capFrom(db, repo, issue, now)) !== null
  );
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

/** Crew `changes_requested` verdicts on one pull, with no approval or person's word between, before it is a person's. */
export const HANDOVER_ROUNDS = 3;

/** What the hand-over card starts with: the thread's own record of it, and what `handover` ignores as a person's word. */
export const HANDOVER_NOTE = "Handed to a person by the crew:";

export interface Handover {
  /** The crew reviewer's verdicts that asked for changes, oldest first. */
  readonly reviews: readonly { id: string; author: string; body: string; at: string }[];
  /** When the third one landed: the card's age. */
  readonly at: string;
}

/**
 * Whether `pullId` has had `HANDOVER_ROUNDS` crew `changes_requested` verdicts
 * since the last approval or the last word of a person who may direct the
 * crew. Counted from the verdict rows, never the runs: a run a restart
 * repeats is one verdict.
 */
export function handoverOf(
  db: Database,
  repo: Repo,
  pullId: string,
): Handover | undefined {
  // The common pull has fewer than three crew verdicts: one cheap count
  // answers it before the approval, comment and director lookups.
  const crewAsked = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM review r
         JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = ?2
        WHERE r.issue_id = ?1 AND r.state = 'changes_requested' AND c.role = 'reviewer'`,
    )
    .get(pullId, repo.id)!.n;
  if (crewAsked < HANDOVER_ROUNDS) return undefined;
  const approved =
    db
      .query<{ at: string | null }, [string]>(
        "SELECT MAX(created_at) AS at FROM review WHERE issue_id = ?1 AND state = 'approved'",
      )
      .get(pullId)?.at ?? "";
  const spoke = db
    .query<{ id: string; at: string }, [string, string]>(
      `SELECT author_id AS id, MAX(created_at) AS at FROM comment
        WHERE issue_id = ?1 AND origin_author IS NULL AND kind != 'review'
          AND body NOT LIKE ?2
        GROUP BY author_id`,
    )
    .all(pullId, `${HANDOVER_NOTE}%`);
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
    .reduce((a, b) => (a > b ? a : b), approved);
  const rounds = db
    .query<
      { id: string; author: string; body: string; at: string },
      [string, string, string]
    >(
      `SELECT r.id AS id, u.username AS author, r.body AS body, r.created_at AS at
         FROM review r JOIN user u ON u.id = r.author_id
         JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = ?3
        WHERE r.issue_id = ?1 AND r.state = 'changes_requested'
          AND r.created_at > ?2 AND c.role = 'reviewer'
        ORDER BY r.created_at, r.id`,
    )
    .all(pullId, since, repo.id);
  if (rounds.length < HANDOVER_ROUNDS) return undefined;
  return { reviews: rounds, at: rounds[HANDOVER_ROUNDS - 1]!.at };
}

/** One line per review, for the card and the thread: who asked, and the first line of what. */
export function handoverLines(h: Handover): string[] {
  return h.reviews.slice(0, HANDOVER_ROUNDS).map((r, n) => {
    const first = (r.body.split("\n").find((l) => l.trim() !== "") ?? "no words")
      .trim()
      .slice(0, 140);
    return `${n + 1}. ${r.author}: ${first}`;
  });
}

/**
 * The open pulls of an autonomous repository whose review loop is spent:
 * the planner's to re-scope, split or send one more round with the
 * reviewer's ask restated, never the owner's. Shaped like a parked issue so
 * the planner's brief and its once-per-pass clock read both alike.
 */
export function handedOverPulls(
  db: Database,
  repo: Repo,
): {
  issueId: string;
  repoId: string;
  number: number;
  title: string;
  reasons: string[];
  byAgent: boolean;
  at: string;
  pull: true;
}[] {
  if (repo.autonomy !== "autonomous") return [];
  const out = [];
  for (const pull of listPulls(db, repo.id, { sealed: true, state: "open", limit: 50 })) {
    if (!pull.authorIsAgent) continue;
    const over = handoverOf(db, repo, pull.id);
    if (over === undefined) continue;
    out.push({
      issueId: pull.id,
      repoId: repo.id,
      number: pull.number,
      title: pull.title,
      reasons: handoverLines(over),
      byAgent: true,
      at: over.at,
      pull: true as const,
    });
  }
  return out;
}

/** The note the pull's thread keeps of the hand-over. */
export function handoverNote(h: Handover, toPlanner = false): string {
  if (toPlanner)
    return [
      `${HANDOVER_NOTE} the reviewer asked for changes three times with no approval between, so the planner re-scopes it: split, replaced, or one more round with the reviewer's ask restated.`,
      "",
      ...handoverLines(h),
    ].join("\n");
  return [
    `${HANDOVER_NOTE} the reviewer asked for changes three times with no approval between, so no more feedback runs start here until you say what to try.`,
    "",
    ...handoverLines(h),
  ].join("\n");
}
