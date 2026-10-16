/**
 * A pull with changes requested always moves (#2172).
 *
 * Every tick, for each open crew pull whose reviewer's latest verdict is
 * "changes requested" (`core/requested.ts`):
 *
 * - On an older head than the pull's, with that head green: the reviewer
 *   is asked again. The verdict was about code that is no longer there,
 *   so it never blocks; a head that was never sent is sent however long
 *   it has been green (`sendToReview`'s `stale`).
 * - On the current head, with no run in flight on the pull and none
 *   started since the verdict: a feedback run is queued to the pull's
 *   builder, one being assigned when the pull has none. One run per pull,
 *   and each takes a builder slot — `free` is how many the tick has.
 *
 * Every pull it passes over gets one line saying why, said once until the
 * reason changes, so a stall is never silent and never a flood.
 */

import type { App } from "../app.ts";
import { assignIssue } from "../actions/issues.ts";
import { getAgent, listCrewRoles, type Agent } from "../core/agents.ts";
import { getHold } from "../core/holds.ts";
import { getIssueById } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { requestedPulls, verdictIsStale, type RequestedPull } from "../core/requested.ts";
import { reviewSummary } from "../core/reviews.ts";
import { activeRunFor } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { queueAgentRun } from "./dispatch.ts";
import { handoverOf } from "./guard.ts";
import { greenHead, sendToReview } from "./review.ts";
import { pickBuilder } from "./route.ts";

const log = createLog("crew");

/** What the tick did with one pull: moved it, or why not. */
export type RequestedMove =
  | { readonly pull: number; readonly did: "asked reviewer" }
  | { readonly pull: number; readonly did: "queued feedback"; readonly builder: string; readonly assigned: boolean }
  | { readonly pull: number; readonly did: "not moved"; readonly why: string };

/**
 * The last why-not said for a pull, so it is said once: a log dedupe, in
 * memory, keyed `repo:pull` across every repository. Each tick drops its
 * repository's keys for pulls no longer waiting; a repository that stops
 * ticking keeps its few until the process restarts, which only means one
 * line is said again.
 */
const said = new Map<string, string>();

/**
 * Move every pull with changes requested in `repo` that can move, taking
 * at most `free` builder slots. Returns what happened to each, oldest
 * verdict first.
 */
export async function moveRequested(
  app: App,
  repo: Repo,
  free: number,
  now = new Date(),
): Promise<RequestedMove[]> {
  const moves: RequestedMove[] = [];
  const crew = listCrewRoles(app.db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  let slots = free;
  for (const requested of requestedPulls(app.db, repo.id)) {
    const move = verdictIsStale(requested)
      ? await askAgain(app, repo, requested, now)
      : slots <= 0
        ? notMoved(requested, "waits for a builder slot")
        : followUp(app, repo, requested, builders);
    if (move.did === "queued feedback") slots--;
    moves.push(move);
    say(repo, requested, move);
  }
  const open = new Set(moves.map((m) => `${repo.id}:${m.pull}`));
  for (const key of said.keys())
    if (key.startsWith(`${repo.id}:`) && !open.has(key)) said.delete(key);
  return moves;
}

const notMoved = (p: RequestedPull, why: string): RequestedMove => ({
  pull: p.number,
  did: "not moved",
  why,
});

/** A push has come since the verdict: the reviewer reads the new head. */
async function askAgain(
  app: App,
  repo: Repo,
  requested: RequestedPull,
  now: Date,
): Promise<RequestedMove> {
  const pull = getPull(app.db, repo.id, requested.number);
  if (!pull) return notMoved(requested, "no pull row");
  if (!greenHead(app.db, pull)) return notMoved(requested, "the new head is not green yet");
  const result = await sendToReview(app, repo, pull, now, { stale: true });
  if (result === "sent") return { pull: requested.number, did: "asked reviewer" };
  return notMoved(
    requested,
    result === "wait"
      ? "a review of the new head is out or could not be queued"
      : result === "lapsed"
        ? "the new head's review lapsed; waits for a person"
        : result === "held"
          ? "held, or handed to a person"
          : result === "done"
            ? "a verdict is already on the new head"
            : "no reviewer on the crew",
  );
}

/** The verdict is on the current head: the builder answers it. */
function followUp(
  app: App,
  repo: Repo,
  requested: RequestedPull,
  builders: readonly Agent[],
): RequestedMove {
  const pull = getPull(app.db, repo.id, requested.number);
  const issue = getIssueById(app.db, requested.pullId);
  if (!pull || !issue) return notMoved(requested, "no pull row");
  if (getHold(app.db, pull.id) !== undefined) return notMoved(requested, "a person holds it");
  if (handoverOf(app.db, repo, pull.id) !== undefined)
    return notMoved(requested, "handed to a person after the review rounds");
  // Past the rounds the verdict is advice, and the pull lands as it is.
  if (reviewSummary(app.db, pull.id, pull.headOid).changesRequested === 0)
    return notMoved(requested, "past the review rounds; the verdict is advice");
  if (activeRunFor(app.db, "agent", pull.id) !== undefined)
    return notMoved(requested, "a run is in flight");
  if (startedSince(app, pull.id, requested.at))
    return notMoved(requested, "a run since the verdict ended without a push");
  if (builders.length === 0) return notMoved(requested, "no builder on the crew");
  const assignee = issue.assigneeId;
  let builder = builders.find((b) => b.user.id === assignee);
  let assigned = false;
  if (builder === undefined) {
    // A person's name on it is a person holding it; an agent that does not
    // build here, or no name at all, is a pull without a builder.
    if (assignee !== null && getAgent(app.db, assignee) === undefined)
      return notMoved(requested, "assigned to a person");
    builder =
      builders.find((b) => b.user.id === issue.authorId) ??
      pickBuilder(issue, builders, new Map());
    const by = repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy);
    if (builder === undefined || by === undefined)
      return notMoved(requested, "nobody to assign a builder as");
    const done = assignIssue(app, by, repo, issue, builder.user);
    if (!done.ok) return notMoved(requested, `could not assign ${builder.user.username}: ${done.error}`);
    assigned = true;
  }
  const current = getIssueById(app.db, issue.id) ?? issue;
  // The assignment may already have queued the builder's run; either is the one.
  const run =
    queueAgentRun(app, repo, current, builder, "feedback") ??
    activeRunFor(app.db, "agent", pull.id, builder.user.id);
  if (run === undefined)
    return notMoved(requested, `${builder.user.username}'s run was not queued (ceiling, cap or breaker)`);
  return {
    pull: requested.number,
    did: "queued feedback",
    builder: builder.user.username,
    assigned,
  };
}

/** Whether a run other than a review started on the pull after the verdict. */
function startedSince(app: App, pullId: string, at: string): boolean {
  return (
    app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'
           AND reason != 'review' AND created_at > ?2
           AND summary NOT LIKE 'skipped: %'`,
      )
      .get(pullId, at)!.n > 0
  );
}

/** A move is always said; a why-not once, until it changes. */
function say(repo: Repo, requested: RequestedPull, move: RequestedMove): void {
  const where = { repo: `${repo.ownerName}/${repo.name}`, pull: requested.number };
  const key = `${repo.id}:${requested.number}`;
  if (move.did === "not moved") {
    const line = `${requested.headOid}:${move.why}`;
    if (said.get(key) === line) return;
    said.set(key, line);
    log.info(`changes requested: not moved, ${move.why}`, where);
    return;
  }
  said.delete(key);
  log.info(
    move.did === "asked reviewer"
      ? "changes requested on an older head: reviewer asked again"
      : "changes requested on the head: feedback queued",
    move.did === "queued feedback"
      ? { ...where, builder: move.builder, ...(move.assigned ? { assigned: true } : {}) }
      : where,
  );
}
