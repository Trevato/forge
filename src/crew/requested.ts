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
 *   When that run ended without a push, one more is queued carrying the
 *   verdict and the run's final answer; when that one too ended without
 *   one, the pull is handed to a person and the pass stops.
 *
 * Every pull it passes over gets one line saying why, said once until the
 * reason changes, so a stall is never silent and never a flood.
 */

import type { App } from "../app.ts";
import { addComment, assignIssue } from "../actions/issues.ts";
import { getAgent, listCrewRoles, type Agent } from "../core/agents.ts";
import { getHold } from "../core/holds.ts";
import { getIssueById, listComments, type Issue } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { requestedPulls, verdictIsStale, type RequestedPull } from "../core/requested.ts";
import { reviewSummary } from "../core/reviews.ts";
import { activeRunFor } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { sliced } from "../kernel/breathe.ts";
import { createLog } from "../kernel/log.ts";
import { authorsInRepoPull, BACK_WITH_AUTHOR } from "./authors_pull.ts";
import { queueAgentRun } from "./dispatch.ts";
import { interruptionOf } from "./interrupted.ts";
import { HANDOVER_NOTE, handoverOf } from "./guard.ts";
import { isFirstChange } from "./first_change.ts";
import { greenHead, sendToReview } from "./review.ts";
import { pickBuilder } from "./route.ts";
import { NO_BUILDER_ON_CREW, WAITS_FOR_BUILDER_SLOT } from "./words.ts";

const log = createLog("crew");

/** The runs a verdict gets from this pass before a person has it: the first, and one more with its words. */
const FOLLOW_UPS = 2;

/** What the tick did with one pull: moved it, or why not. */
export type RequestedMove =
  | { readonly pull: number; readonly did: "asked reviewer" }
  | { readonly pull: number; readonly did: "queued feedback"; readonly builder: string; readonly assigned: boolean }
  | { readonly pull: number; readonly did: "not moved"; readonly why: string };

/** What a tick did across its pulls, as plain data: `moved` of `total`, the rest counted by reason. */
export interface RequestedTally {
  readonly moved: number;
  readonly total: number;
  readonly waiting: Readonly<Record<string, number>>;
}

/** The reason a pull did not move, in the few words the tick line groups by. */
function reasonOf(why: string): string {
  if (why === "a run is in flight" || why.startsWith("a review of the new head")) return "a run is in flight";
  if (why === "a person holds it" || why.startsWith("held,")) return "held";
  if (why.includes("a person")) return "handed to a person";
  if (why === WAITS_FOR_BUILDER_SLOT) return "waits for a slot";
  if (why === "the new head is not green yet") return "waits for a check";
  if (why.startsWith("past the review rounds") || why.startsWith("a verdict is already") || why.startsWith("a run since"))
    return "settled";
  return "cannot move";
}

/** Count a pass's moves: moved are the runs queued or reviewers asked, the rest grouped by reason. */
export function tallyRequested(moves: readonly RequestedMove[]): RequestedTally {
  const waiting: Record<string, number> = {};
  let moved = 0;
  for (const m of moves) {
    if (m.did !== "not moved") moved++;
    else waiting[reasonOf(m.why)] = (waiting[reasonOf(m.why)] ?? 0) + 1;
  }
  return { moved, total: moves.length, waiting };
}

/** The tally as the tick line says it: `2/8 moved; 3 a run is in flight, 1 held`. */
export function tallyWords(t: RequestedTally): string {
  const rest = Object.entries(t.waiting)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([why, n]) => `${n} ${why}`);
  return `${t.moved}/${t.total} moved${rest.length === 0 ? "" : `; ${rest.join(", ")}`}`;
}

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
  const slice = sliced();
  for (const requested of requestedPulls(app.db, repo.id)) {
    if (slice.due()) await slice.breathe();
    let move: RequestedMove;
    if (verdictIsStale(requested)) move = await askAgain(app, repo, requested, now);
    else if (slots <= 0) move = notMoved(requested, WAITS_FOR_BUILDER_SLOT);
    else move = followUp(app, repo, requested, builders);
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
  // An app's first change lands on green; what was asked becomes a follow-up (`first_change.ts`).
  if (isFirstChange(app.db, repo, pull)) return notMoved(requested, "lands on green as the app's first change");
  if (handoverOf(app.db, repo, pull.id) !== undefined)
    return notMoved(requested, "handed to a person after the review rounds");
  // Past the rounds the verdict is advice, and the pull lands as it is.
  if (reviewSummary(app.db, pull.id, pull.headOid).changesRequested === 0)
    return notMoved(requested, "past the review rounds; the verdict is advice");
  // No builder can push a branch of the repository itself (#7572).
  if (authorsInRepoPull(pull)) return handBack(app, repo, requested, issue);
  if (activeRunFor(app.db, "agent", pull.id) !== undefined)
    return notMoved(requested, "a run is in flight");
  // A push ends the verdict's turn (the reviewer reads the new head), so every
  // run counted here ended without one: one is asked again, two go to a person.
  const tried = startedSince(app, pull.id, requested.at);
  if (tried >= FOLLOW_UPS) return handOverPushless(app, repo, requested, issue);
  if (builders.length === 0) return notMoved(requested, NO_BUILDER_ON_CREW);
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
    queueAgentRun(app, repo, current, builder, "feedback", undefined, undefined, undefined, tried > 0) ??
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

/**
 * A person's in-repo pull with changes asked for is theirs to answer: it is
 * assigned back to its author, once, and no builder is sent — its run could
 * only fail, and the failure would park the pull.
 */
function handBack(app: App, repo: Repo, requested: RequestedPull, issue: Issue): RequestedMove {
  if (issue.assigneeId !== issue.authorId) {
    const author = getUserById(app.db, issue.authorId);
    const by = (repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy)) ?? author;
    if (author === undefined || by === undefined) return notMoved(requested, "nobody to hand it back to");
    const done = assignIssue(app, by, repo, issue, author);
    if (!done.ok) return notMoved(requested, `could not hand it back to ${author.username}: ${done.error}`);
  }
  return notMoved(requested, BACK_WITH_AUTHOR);
}

/**
 * How many follow-up runs ended on the pull after the verdict having really
 * run: reached the agent and pushed nothing. A run that was paused (the
 * model's limit, an outage), cut short by a restart or the host, never
 * started, or was skipped is no attempt: a pause is not a failed follow-up.
 */
function startedSince(app: App, pullId: string, at: string): number {
  return app.db
    .query<{ summary: string | null }, [string, string]>(
      `SELECT summary FROM run WHERE issue_id = ?1 AND kind = 'agent'
         AND reason != 'review' AND created_at > ?2
         AND state IN ('ok','failed')`,
    )
    .all(pullId, at)
    .filter(({ summary }) => {
      const said = summary ?? "";
      return !said.startsWith("skipped: ") && !/^paused\b/i.test(said) && interruptionOf(said) === undefined;
    }).length;
}

/** The builder has had its follow-ups and pushed nothing: one note, from the reviewer, and no more runs. */
function handOverPushless(
  app: App,
  repo: Repo,
  requested: RequestedPull,
  issue: Issue,
): RequestedMove {
  const said = listComments(app.db, issue.id).some(
    (c) => c.body.startsWith(HANDOVER_NOTE) && c.createdAt >= requested.at,
  );
  const reviewer = getUserById(app.db, requested.reviewerId);
  if (!said && reviewer !== undefined) {
    addComment(
      app,
      reviewer,
      repo,
      issue,
      `${HANDOVER_NOTE} two follow-up runs on the review's changes ended without a push, so no more start here until you say what to try. (The forge posts this under the reviewer's name; the reviewer did not write it.)`,
    );
    log.info("handed to a person after two follow-ups without a push", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: issue.number,
    });
  }
  return notMoved(requested, "handed to a person after two follow-ups ended without a push");
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
