/**
 * Who reviews a pull, and sending it to them.
 *
 * A crew may carry more than one reviewer: one who reads for the
 * experience, one who reads for security. A pull that touches the
 * security-bearing paths goes to the second; every other pull goes to the
 * first. Which reviewer watches security is read from what the agent says
 * it is — the first paragraph of its brief, before the rules every brief
 * shares — so naming a reviewer is all it takes to give it the job.
 *
 * Every green head of a pull an agent wrote is sent, whatever the
 * repository's autonomy: the event sends it the moment its checks pass,
 * and the tick sweeps up any head the event missed. A review that does
 * not come back is sent once more; after that it has lapsed, and the pull
 * is not held for it (`reviewStage`).
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { listCrewRoles, type Agent } from "../core/agents.ts";
import { getHold, lastRelease } from "../core/holds.ts";
import { getIssueById } from "../core/issues.ts";
import { listPulls, pullDiff, type Pull, pullDir} from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { reviewSummary } from "../core/reviews.ts";
import { checksForHead } from "../core/runs.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { queueAgentRun } from "./dispatch.ts";

const log = createLog("crew");

/** Paths whose change is the security reviewer's to read: sign-in, tokens, secrets, the sandbox, the HTTP edge. */
const SECURITY_PATH = /auth|token|secret|sandbox|http/i;

export const touchesSecurity = (paths: readonly string[]): boolean =>
  paths.some((p) => SECURITY_PATH.test(p));

/** What an agent says it is: its brief's first paragraph. */
const focusOf = (brief: string): string =>
  brief.trim().split(/\n\s*\n/)[0] ?? "";

/** Whether this reviewer says it reads for security. */
export const watchesSecurity = (agent: Agent): boolean =>
  /\bsecurity\b/i.test(focusOf(agent.brief));

/**
 * The reviewer for a change to these paths: the security reviewer when
 * the change touches what it watches, the experience reviewer otherwise,
 * and whichever reviewer there is when the crew has only one kind.
 */
export function pickReviewer(
  reviewers: readonly Agent[],
  paths: readonly string[],
): Agent | undefined {
  const security = reviewers.filter(watchesSecurity);
  const experience = reviewers.filter((r) => !watchesSecurity(r));
  const preferred = touchesSecurity(paths) ? security : experience;
  return preferred[0] ?? reviewers[0];
}

/** The crew's reviewers on a repository. */
export const reviewersOf = (db: Database, repoId: string): Agent[] =>
  listCrewRoles(db, repoId)
    .filter((c) => c.role === "reviewer")
    .map((c) => c.agent);

/** Whether every check on the pull's head ran and passed. */
export function greenHead(db: Database, pull: Pull): boolean {
  const checks = checksForHead(db, pull.id, pull.headOid);
  return checks.length > 0 && checks.every((c) => c.state === "ok");
}

/** How long a review may take from being queued before it is sent again. */
export const REVIEW_WAIT_MS = 20 * 60_000;
/** How long a green head waits for a verdict at most, however the attempts went. */
export const REVIEW_LAPSE_MS = 60 * 60_000;
/** Review runs one head gets: the first, and one more. */
const REVIEW_TRIES = 2;

/** One review run sent for a head: when it was queued, and whether it is still out. */
export interface ReviewAttempt {
  readonly createdAt: string;
  readonly active: boolean;
}

/**
 * Where review stands on a green head that has no verdict: `send` a
 * review run (the first, or the one retry), `wait` for the one that is
 * out, or `lapsed` — two runs came back with nothing, or the head has
 * waited past the lapse — and the pull goes on without one. A missing
 * reviewer must never hold a pull silently.
 */
export function reviewStage(
  greenAt: string,
  attempts: readonly ReviewAttempt[],
  now: Date,
): "send" | "wait" | "lapsed" {
  const at = now.getTime();
  if (at - Date.parse(greenAt) >= REVIEW_LAPSE_MS) return "lapsed";
  const last = attempts.at(-1);
  if (last === undefined) return "send";
  const fresh = at - Date.parse(last.createdAt) < REVIEW_WAIT_MS;
  if (last.active && fresh) return "wait";
  return attempts.length < REVIEW_TRIES ? "send" : "lapsed";
}

/**
 * When the pull's head first went green, and the review runs sent for it
 * since — read from the run table, so a restart forgets nothing.
 *
 * A hold stops this clock. Review is owed from when the head went green or
 * from when the pull was last let go, whichever is later, and only runs
 * sent since then count: a pull held past the lapse and then released is
 * sent to review like any newly green one, never landed as "lapsed".
 */
export function reviewAttempts(
  db: Database,
  pull: Pull,
): { greenAt: string; attempts: ReviewAttempt[] } | undefined {
  const green = db
    .query<{ at: string | null }, [string, string]>(
      `SELECT MIN(finished_at) AS at FROM run WHERE issue_id = ?1 AND commit_oid = ?2
         AND kind IN ('check','deploy') AND state = 'ok'`,
    )
    .get(pull.id, pull.headOid)?.at;
  if (green === null || green === undefined) return undefined;
  const released = lastRelease(db, pull.id);
  const since = released !== undefined && released > green ? released : green;
  const attempts = db
    .query<{ created_at: string; state: string }, [string, string]>(
      `SELECT created_at, state FROM run WHERE issue_id = ?1 AND kind = 'agent'
         AND reason = 'review' AND created_at >= ?2 ORDER BY created_at, id`,
    )
    .all(pull.id, since)
    .map((r) => ({
      createdAt: r.created_at,
      active: r.state === "queued" || r.state === "running",
    }));
  return { greenAt: since, attempts };
}

/**
 * Move review along on this green head: send it to the right reviewer
 * when it is due (`reviewStage`), and say where it stands. `none` when
 * there is nothing to wait for — no reviewer on the crew — and `done`
 * when a verdict is on the head. A run the pull's builder still has open
 * does not stop a send — the review queues behind it. `held` when a person
 * holds the pull: nothing is sent, whoever asks.
 */
export async function sendToReview(
  app: App,
  repo: Repo,
  pull: Pull,
  now = new Date(),
): Promise<"none" | "done" | "sent" | "wait" | "lapsed" | "held"> {
  if (getHold(app.db, pull.id) !== undefined) return "held";
  const reviewers = reviewersOf(app.db, repo.id);
  if (reviewers.length === 0) return "none";
  const seen = reviewSummary(app.db, pull.id, pull.headOid);
  if (seen.approvals > 0 || seen.changesRequested > 0) return "done";
  const history = reviewAttempts(app.db, pull);
  if (history === undefined) return "wait";
  const stage = reviewStage(history.greenAt, history.attempts, now);
  if (stage !== "send") return stage;
  const issue = getIssueById(app.db, pull.id);
  if (!issue) return "wait";
  const { diff } = await pullDiff(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );
  const reviewer = pickReviewer(
    reviewers,
    diff.files.map((f) => f.path),
  );
  if (reviewer === undefined) return "wait";
  if (queueAgentRun(app, repo, issue, reviewer, "review") === undefined)
    return "wait";
  log.info("green; queued for review", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    reviewer: reviewer.user.username,
    attempt: history.attempts.length + 1,
  });
  return "sent";
}

/**
 * Every open, green pull an agent wrote that has no verdict on its head,
 * in every repository with a reviewer on its crew, sent to review. The
 * tick's net under the check event; returns how many went.
 */
export async function sweepReviews(app: App): Promise<number> {
  const repoIds = app.db
    .query<{ repo_id: string }, []>(
      "SELECT DISTINCT repo_id FROM repo_crew WHERE role = 'reviewer'",
    )
    .all()
    .map((r) => r.repo_id);
  let queued = 0;
  for (const id of repoIds) {
    const repo = getRepoById(app.db, id);
    if (!repo) continue;
    for (const pull of listPulls(app.db, repo.id, { sealed: true,
      state: "open",
      limit: 50,
    })) {
      if (!pull.authorIsAgent || !greenHead(app.db, pull)) continue;
      if ((await sendToReview(app, repo, pull)) === "sent") queued++;
    }
  }
  return queued;
}
