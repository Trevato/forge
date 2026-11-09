/**
 * What asks a person, and what they can do about it: a *decision* is one
 * card — a pull the crew stopped on, a green pull waiting for a look, or a
 * repository parked at its ceiling — read from the same tables the rest of
 * the forge reads, with the same access the owner has. This module owns
 * which asks there are, the row and the panel of them; the card's words,
 * forms and buttons are `decisions.ts`.
 */

import type { Database } from "bun:sqlite";
import { crewHandsFor } from "../../actions/give_back.ts";
import { forgeVitals, needLine } from "../../actions/health.ts";
import { reviewSet } from "./review_set.ts";
import type { Degraded } from "../../kernel/vitals.ts";
import { waitingFor, type WaitingFor } from "../../core/waiting_for.ts";
import { crewForRepos } from "../../core/agents.ts";
import { appsForRepos } from "../../core/apps.ts";
import { latestDecision, latestDecisionsFor, stopStands } from "../../core/decisions.ts";
import { lastPersonAction, recommendationsFor, waitWords, WAIT_LIMIT_MS, type Recommendation } from "../../core/pull_wait.ts";
import { getHold, holdsFor } from "../../core/holds.ts";
import { issueTitles, proposalsFor, type Proposal } from "../../core/proposals.ts";
import { chipsOf, type Chips } from "../../core/feed_chips.ts";
import { chipHides } from "../../feed/chips.ts";
import { askDismissals, mutedRepos } from "../../core/interactions.ts";
import { ASKS_WINDOW_DAYS, askMeasureWeek, syncAskLedger, type AskEnd } from "../../core/ask_ledger.ts";
import {
  getIssueById,
  labelsForIssues,
  listAssignedTo,
  listComments,
  listOpenPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { reviewSummary } from "../../core/reviews.ts";
import { mayView } from "../../core/sealed.ts";
import { closesFromBody, getPull, joinMany, type Pull } from "../../core/pulls.ts";
import {
  canRead,
  getReposByIds,
  listReposVisibleTo,
  canWrite,
  listReposWritableTo,
  ownerFactRepoIds,
  type Repo,
} from "../../core/repos.ts";
import {
  activeRunsFor,
  automaticRunsSinceFor,
  latestRunsForIssues,
  type Run,
} from "../../core/runs.ts";
import { getUserById, getUsersByIds, type User } from "../../core/users.ts";
import {
  isPausedAtCeiling,
  plannerDeclines,
  spentTodayForRepos,
} from "../../crew/autonomy.ts";
import { breakerParked, WAITING_NOTES } from "../../crew/breaker.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
import { handoversOf, passReasonOf, type Handover } from "../../crew/guard.ts";
import { conflictsOf, isStalePull, mergesAgainSince, staleGreen } from "../../crew/stale_asks.ts";
import { reviewSays } from "../../crew/review_says.ts";
import { reviewerPaused } from "../../crew/reviewer_paused.ts";
import { reviewWaitsFor, type ReviewWait } from "../../crew/review.ts";
import type { Ctx } from "../../http/context.ts";
import { NO_LONGER_ASKS } from "../../actions/asks_words.ts";

/** Repos narrowed to those with an app record, with the records — the one
 * join `appsOf` and `writableAppsOf` share. */
function appsFiltered(
  ctx: Pick<Ctx, "app">,
  repos: readonly Repo[],
): { repos: Repo[]; records: ReturnType<typeof appsForRepos> } {
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return { repos: repos.filter((r) => records.has(r.id)), records };
}

/** The apps a person can see, as repositories, with their records — the
 * same visibility a signed-out reader gets from `listReposVisibleTo` too.
 * Everyone's public apps sit in this list beside the viewer's own: right
 * for search, the palette and the asks count, wrong for a shelf headed
 * "your apps" — that reading is `writableAppsOf`. */
export function appsOf(ctx: Pick<Ctx, "app">, user: User | undefined, archived = false) {
  return appsFiltered(
    ctx,
    listReposVisibleTo(
      ctx.app.db,
      user,
      archived ? { limit: 200, archivedOnly: true } : { limit: 200, withoutArchived: true },
    ),
  );
}

/** The apps a person can write — their own, or their organisations' — as
 * repositories, with their records. This is "your apps": the studio home's
 * shelf and its cost line, never widened by what a stranger merely made
 * public. */
export function writableAppsOf(ctx: Ctx, user: User | undefined) {
  return appsFiltered(
    ctx,
    listReposWritableTo(ctx.app.db, user, {
      limit: 200,
      withoutArchived: true,
    }),
  );
}

export type DecisionKind = "stopped" | "look" | "review" | "paused" | "parked" | "declined" | "handover" | "waiting" | "assigned" | "proposal";

export interface Decision {
  readonly kind: DecisionKind;
  /** Stable across renders — the kind and what it is about — so a form can
   * name it and a later request can find it again. */
  readonly id: string;
  readonly repo: Repo;
  readonly pull?: Pull | undefined;
  /** For "parked": the issue the breaker stopped; for "declined": the
   * direction issue the planner declined. */
  readonly issue?: Issue | undefined;
  /** For "proposal": the wave waiting for a nod. */
  readonly proposal?: Proposal | undefined;
  readonly who: string;
  /** Three sentences at most: what, why, what happens next. */
  readonly says: string;
  /** The same in one clause, for a row. */
  readonly short: string;
  /** Free text a crew member wrote that the row quotes after `short` — a
   * planner's decline, from its run's summary. A row shows it through
   * `noteLine` (`./note.ts`): one escaped, clamped line (#10199). */
  readonly note?: string | undefined;
  /** The option the decider thinks is right, and how sure; none for a rule. */
  readonly likely?: { readonly option: string; readonly p: number } | undefined;
  /** The preview pictured on a phone, when the forge has taken one. */
  readonly picture?: string | undefined;
  /** Where the pull's preview opens, when its repository is an app. */
  readonly preview?: string | undefined;
  readonly consequence: Consequence;
  /** What it waits for, and on whom (`core/waiting_for.ts`). */
  readonly waiting: WaitingFor;
  readonly why?: string | undefined;
  readonly recommendation?: Recommendation | undefined;
  /** For "handover" and a pass-assigned "assigned": the builder the pull can be given back to, if any. */
  readonly giveBack?: string | undefined;
  /** For "assigned" pull: whether landing is allowed now (green, no outstanding change request). */
  readonly canLand?: boolean | undefined;
}

/** What an ask asks, the answers it takes, and what happens if nobody gives one. */
export interface AskWords {
  readonly decision: string;
  readonly options: readonly string[];
  readonly ifNothing: string;
}

/** The words for each kind of ask: every ask names its decision, its options and its default. */
export const ASK_WORDS: Readonly<Record<DecisionKind, AskWords>> = {
  look: {
    decision: "Ship this pull request?",
    options: ["Ship", "Say what is off"],
    ifNothing: "it waits; nothing ships",
  },
  review: {
    decision: "Review this pull request: ship it, or say what is off?",
    options: ["Ship", "Say what is off"],
    ifNothing: "it waits; an agent's change never ships unreviewed",
  },
  waiting: {
    decision: "No one has looked at this in a day: merge it, close it, or say what to change?",
    options: ["Ship", "Say what to change", "Close it"],
    ifNothing: "it keeps waiting for you",
  },
  stopped: {
    decision: "The check fails and the crew stopped: what should it try?",
    options: ["Tell them what to try", "Close it"],
    ifNothing: "it stays red; the crew tries nothing more",
  },
  parked: {
    decision: "What should the crew try next?",
    options: ["Tell them"],
    ifNothing: "nothing more starts on it",
  },
  handover: {
    decision: "The reviewer asked for changes three times: what should the builder try?",
    options: ["Tell them what to try", "Close it"],
    ifNothing: "no more feedback runs start; the pull waits for you",
  },
  declined: {
    decision: "The planner declined the direction: answer it?",
    options: ["Answer the planner"],
    ifNothing: "the planner plans nothing more for this app",
  },
  assigned: {
    decision: "This is assigned to you: act on it?",
    options: ["Give to the crew", "Land", "Close"],
    ifNothing: "it stays assigned to you",
  },
  proposal: {
    decision: "Open this wave of issues?",
    options: ["Approve", "Redirect", "Later"],
    ifNothing: "it stays proposed; no issue is opened",
  },
  paused: {
    decision: "Raise today's ceiling?",
    options: ["Raise it in settings"],
    ifNothing: "the crew starts again at 00:00 UTC",
  },
};

/**
 * How much an ask matters, as a score and the reason: security first, then
 * money, then what holds other work up, then the rest by kind — and, inside
 * a tier, the older first (the age part stays under 1, so it never crosses
 * a tier). `consequenceOf` is the one place this order is decided.
 */
export interface Consequence {
  readonly score: number;
  readonly why: string;
}

/** The tier of a kind when nothing about the thing itself says more. */
export const KIND_TIER: Readonly<Record<DecisionKind, Consequence>> = {
  proposal: { score: 60, why: "a wave of work waits for your nod" },
  paused: { score: 80, why: "money: the crew is stopped at its ceiling" },
  declined: { score: 70, why: "the planner has stopped for this app" },
  stopped: { score: 50, why: "red, and the crew stopped" },
  review: { score: 45, why: "an agent's change waits for a review" },
  waiting: { score: 42, why: "no person has acted on it for a day" },
  handover: { score: 55, why: "three reviews without an approval: handed to a person" },
  parked: { score: 40, why: "parked by the crew" },
  look: { score: 30, why: "green, waiting" },
  assigned: { score: 20, why: "assigned to you" },
};

/**
 * When a person last spoke on each of these conversations, or its start,
 * by issue: anyone but its author, in a comment or a review — one query
 * per chunk each, never a read per conversation.
 */
function lastHumanWords(db: Database, issues: readonly Issue[]): Map<string, string> {
  const out = new Map(issues.map((i) => [i.id, i.createdAt]));
  const author = new Map(issues.map((i) => [i.id, i.authorName]));
  const ids = [...out.keys()];
  const CHUNK = 400;
  for (let n = 0; n < ids.length; n += CHUNK) {
    const batch = ids.slice(n, n + CHUNK);
    const marks = batch.map((_, k) => `?${k + 1}`).join(",");
    for (const table of ["comment", "review"] as const)
      for (const row of db
        .query<{ issue_id: string; name: string; at: string }, string[]>(
          `SELECT ${table}.issue_id, user.username AS name, MAX(${table}.created_at) AS at
             FROM ${table} JOIN user ON user.id = ${table}.author_id
            WHERE ${table}.issue_id IN (${marks})
            GROUP BY ${table}.issue_id, user.username`,
        )
        .all(...batch))
        if (row.name !== author.get(row.issue_id) && row.at > out.get(row.issue_id)!)
          out.set(row.issue_id, row.at);
  }
  return out;
}

/**
 * A candidate ask, classified but not yet worded or pictured: the set
 * `decisionsFor` and `askCountFor` both build from, so a count can never
 * disagree with the list it is a count of.
 */
interface AskCandidate {
  readonly kind: DecisionKind;
  /** The ask's own id, `kind:what` (see `Decision.id`). */
  readonly id: string;
  /** When its cause last changed: a dismissal before this no longer holds. */
  readonly since: string;
  readonly repo: Repo;
  readonly pull?: Pull;
  readonly issue?: Issue;
  /** For "proposal": the wave waiting for a nod. */
  readonly proposal?: Proposal;
  readonly who: string;
  /** Whether the author is a crew member — a "look" card words itself
   * differently for a person's own change than for the crew's (below).
   * Absent for "paused", which names no author at all. */
  readonly authorIsAgent?: boolean;
  /** For "look": the green check, whose summary says what its tests did. */
  readonly check?: Run;
  /** For "review": why the agent's change waits for a person, and since when. */
  readonly reviewWait?: ReviewWait;
  /** For "stopped": how many automatic tries, and whether the decider itself stopped it. */
  readonly tries?: number;
  readonly stoppedByDecider?: boolean;
  /** For "declined": the declining run and what the planner said. */
  readonly decline?: { readonly runId: string; readonly words: string };
  /** For "handover": the reviews that asked for changes. */
  readonly handover?: Handover;
  /** For "handover" and a pass-assigned "assigned": the crew member that opened or last worked on the pull, when it can be given back. */
  readonly builder?: string;
  /** For an "assigned" pull: it is green with no change requested, so it can land. */
  readonly canLand?: boolean;
  /** For "handover", "waiting" and a pass-assigned "assigned": one sentence on why a person must decide. */
  readonly why?: string;
  /** For "handover" and "waiting": what the crew advised, when it wrote one. */
  readonly recommendation?: Recommendation;
}

/** How a handed-over pull says why: the rounds, and the hand-over. */
const THREE_ROUNDS = "three reviews asked for changes";
const HANDOVER_WHY = `${THREE_ROUNDS} with no approval between; the crew handed it to a person`;

/**
 * Open pulls the viewer may land, sorted into what asks them: stopped (red
 * past the crew's own limit since a person last spoke — the crew's own
 * pulls only, since only the crew retries automatically), or green and
 * waiting for a look, whoever opened it. Plus a repository paused at its
 * ceiling. Every read here is bounded by the pulls a person can see or the
 * repositories handed in — never by a loop that queries once per app: the
 * ceiling check reads spend and crew for every repository in one query
 * each (`spentTodayForRepos`, `crewForRepos`), not `autonomyStatus` per
 * repository.
 */
function askCandidatesFor(
  db: Database,
  user: User | undefined,
  allRepos: readonly Repo[],
  only?: string,
): AskCandidate[] {
  const out: AskCandidate[] = [];
  if (!user) return out;
  // Shipping, closing and the day's ceiling are the owner's own decisions —
  // a reader who cannot write here is never asked to make one, and never
  // sees the dollar figure a "paused" card would otherwise carry.
  const ownerFacts = ownerFactRepoIds(db, allRepos, user);
  const repos = allRepos.filter((r) => ownerFacts.has(r.id));
  const byId = new Map(repos.map((r) => [r.id, r]));
  // `only` narrows to one pull's own asks, for its page: the same fifty
  // pulls are listed, so it asks exactly what the full read would say of it.
  const pulls = listOpenPullsVisibleTo(db, user, 50).filter(
    (p) => byId.has(p.repoId) && (only === undefined || p.id === only),
  );
  const checks = latestRunsForIssues(
    db,
    pulls.map((p) => p.id),
  );
  const joined = new Map(joinMany(db, pulls).map((p) => [p.id, p]));
  const held = holdsFor(
    db,
    pulls.map((p) => p.id),
  );
  const working = activeRunsFor(
    db,
    "agent",
    pulls.map((p) => p.id),
  );
  const handedOver = handoversOf(
    db,
    pulls.map((p) => ({ id: p.id, repo: byId.get(p.repoId)! })),
  );
  // What a pull with a check result reads on its way to a card, read once
  // for every pull that could reach it: the crew's red pulls' tries and
  // stops, and the green pulls' wait for review.
  const settled = pulls.filter(
    (p) =>
      joined.has(p.id) &&
      held.get(p.id)?.heldBy !== user.id &&
      !working.has(p.id) &&
      !handedOver.has(p.id),
  );
  const red = settled.filter((p) => p.authorIsAgent && checks.get(p.id)?.state === "failed");
  const spoke = lastHumanWords(db, red);
  const tried = automaticRunsSinceFor(db, spoke);
  const retries = latestDecisionsFor(db, red.map((p) => p.id), "retry");
  const waits = reviewWaitsFor(
    db,
    settled.flatMap((p) => {
      const pull = joined.get(p.id)!;
      const check = checks.get(p.id);
      return check?.state === "ok" && !isStalePull(db, pull.id, pull.headOid) && !staleGreen(db, pull, check)
        ? [{ repo: byId.get(p.repoId)!, pull }]
        : [];
    }),
    new Date(),
    handedOver,
  );
  const first = out.length;
  let crews: Map<string, string[]> | undefined;
  for (const issue of pulls) {
    const repo = byId.get(issue.repoId)!;
    const pull = joined.get(issue.id);
    if (!pull) continue;
    // Whoever holds a pull has already answered it: "not yet". It asks
    // them nothing until they let it go.
    if (held.get(issue.id)?.heldBy === user.id) continue;
    const check = checks.get(issue.id);
    const who = issue.authorName;
    // The crew is on it: that is working, not a question for a person.
    if (working.has(issue.id)) continue;
    // Three reviews without an approval: the crew stopped, and says so
    // before anything about the check (`guard.ts`).
    const over = handedOver.get(issue.id);
    // An autonomous repository's spent review loop is the planner's
    // (`handedOverPulls`), not a question for a person (#1655).
    // A person's pull has no planner pass to take it, so it still asks.
    if (over !== undefined && repo.autonomy === "autonomous" && issue.authorIsAgent)
      continue;
    if (over !== undefined) {
      // Whoever opened it, while still on the crew, is who it can go back to.
      crews ??= crewForRepos(db, [...byId.keys()]);
      const builder =
        issue.authorIsAgent && crews.get(repo.id)?.includes(issue.authorName) ? issue.authorName : undefined;
      out.push({
        kind: "handover",
        id: `handover:${pull.id}`,
        since: over.at,
        repo,
        pull,
        who,
        authorIsAgent: issue.authorIsAgent,
        handover: over,
        ...(builder === undefined ? {} : { builder }),
        why: HANDOVER_WHY,
      });
      continue;
    }
    if (check?.state === "failed") {
      // Automatic retries, and the limit that stops them, are the crew's
      // own machinery — a person's own failing pull never accrues tries,
      // so it never earns a "stopped" card; it just stays waiting.
      if (!issue.authorIsAgent) continue;
      const tries = tried.get(issue.id) ?? 0;
      const stopped = stopStands(retries.get(issue.id));
      // A repository on its own parks what it cannot finish and moves on;
      // only an assisted one stops here for a person.
      if (
        (tries >= CHECK_FAILED_LIMIT || stopped) &&
        repo.autonomy !== "autonomous"
      )
        out.push({
          kind: "stopped",
          id: `stopped:${pull.id}`,
          since: check.createdAt,
          repo,
          pull,
          who,
          authorIsAgent: true,
          tries,
          stoppedByDecider: stopped,
        });
    } else if (
      check?.state === "ok" &&
      repo.autonomy !== "autonomous" &&
      // A green pull that no longer merges as it stands cannot be shipped:
      // bringing it up to date is work, not a person's decision.
      !isStalePull(db, pull.id, pull.headOid) &&
      // A green checked against an older base is a check still to come.
      !staleGreen(db, pull, check)
    ) {
      // An agent's green pull waits for its reviewer first: it is the
      // crew's to wait on, and reaches the owner with the verdict (#1602).
      if (waits.get(pull.id)?.reviewer !== undefined) continue;
      // Autonomous repositories look at their own green pulls: the decider,
      // then the crew's reviewer. Everything else waits for a person —
      // whoever opened it, since a green change asks to be looked at
      // whether the crew wrote it or a person did.
      out.push({
        kind: "look",
        id: `look:${pull.id}`,
        // New since its green check — or since it merged again, if later.
        since: [check.createdAt, mergesAgainSince(db, pull.id, pull.headOid) ?? ""]
          .reduce((a, b) => (a > b ? a : b)),
        repo,
        pull,
        who,
        authorIsAgent: issue.authorIsAgent,
        check,
      });
    } else if (
      check?.state === "ok" &&
      repo.autonomy === "autonomous" &&
      !isStalePull(db, pull.id, pull.headOid) &&
      !staleGreen(db, pull, check)
    ) {
      // An autonomous repository lands its own green pulls once reviewed;
      // an agent's change with no reviewer, or whose review lapsed, waits
      // for a person — and so asks one (#597).
      const wait = waits.get(pull.id)?.person;
      // A review nobody answered is the sweep's to send, whatever its age
      // (`sendToReview`); every other wait is still a person's.
      const resent =
        wait?.why === "lapsed" && waits.get(pull.id)?.history?.attempts.length === 0;
      if (wait !== undefined && !resent)
        out.push({
          kind: "review",
          id: `review:${pull.id}`,
          since: wait.since,
          repo,
          pull,
          who,
          authorIsAgent: true,
          reviewWait: wait,
        });
    }
  }
  // Whatever else a pull is, one no person has touched for a day is theirs
  // to decide, whatever its check says. The crew's own pull still at work
  // never reaches here; nor does one younger than a day.
  const asked = new Set(out.slice(first).map((a) => a.pull?.id));
  const idle = pulls.filter(
    (p) => joined.has(p.id) && !asked.has(p.id) && held.get(p.id)?.heldBy !== user.id && !working.has(p.id),
  );
  const acted = lastPersonAction(db, idle);
  const nowMs = Date.now();
  const stale = idle.filter((p) => nowMs - Date.parse(acted.get(p.id)!) > WAIT_LIMIT_MS);
  const advice = recommendationsFor(db, [...stale.map((p) => p.id), ...out.slice(first).filter((a) => a.kind === "handover").map((a) => a.pull!.id)]);
  for (const issue of stale) {
    const since = acted.get(issue.id)!;
    const rounds = handedOver.has(issue.id) ? `, ${THREE_ROUNDS}` : "";
    const rec = advice.get(issue.id);
    out.push({
      kind: "waiting",
      id: `waiting:${issue.id}`,
      since,
      repo: byId.get(issue.repoId)!,
      pull: joined.get(issue.id)!,
      who: issue.authorName,
      authorIsAgent: issue.authorIsAgent,
      why: `${waitWords(nowMs - Date.parse(since))}${rounds}`,
      ...(rec === undefined ? {} : { recommendation: rec }),
    });
  }
  for (let i = first; i < out.length; i++) {
    const a = out[i]!;
    const rec = a.kind === "handover" ? advice.get(a.pull!.id) : undefined;
    if (rec !== undefined) out[i] = { ...a, recommendation: rec };
  }
  // Pauses, parked issues, declines and waves carry no pull: one pull's page
  // never shows them, so it never reads them.
  if (only === undefined) repoAsksInto(db, out, repos, byId);
  // Open work assigned to the viewer that no ask above already covers: a
  // pull that is an ask and assigned to them is one row, the ask's.
  const taken = new Set(out.flatMap((a) => [a.pull?.id, a.issue?.id].filter((i) => i !== undefined)));
  const visible = new Map(allRepos.map((r) => [r.id, r]));
  const mine = listAssignedTo(db, user.id, 50).filter(
    (i) => !taken.has(i.id) && (only === undefined || i.id === only),
  );
  const elsewhere = getReposByIds(
    db,
    [...new Set(mine.map((i) => i.repoId))].filter((id) => !visible.has(id)),
  );
  // An assignment can outlive the access that made it: each repo needs a real read.
  // Asked once per repository, not once per assigned row.
  const reads = new Map<string, boolean>();
  const readable = (repo: Repo | undefined): repo is Repo => {
    if (repo === undefined) return false;
    if (visible.has(repo.id)) return true;
    let ok = reads.get(repo.id);
    if (ok === undefined) reads.set(repo.id, (ok = canRead(db, repo, user)));
    return ok;
  };
  const joinedMine = new Map(
    joinMany(db, mine.filter((i) => i.kind === "pull")).map((p) => [p.id, p]),
  );
  const mineChecks = latestRunsForIssues(db, [...joinedMine.keys()]);
  const hands = crewHandsFor(
    db,
    mine.flatMap((issue) => {
      const repo = visible.get(issue.repoId) ?? elsewhere.get(issue.repoId);
      return repo === undefined || issue.assigneeIsAgent ? [] : [{ repo, work: issue }];
    }),
  );
  for (const issue of mine) {
    const repo = visible.get(issue.repoId) ?? elsewhere.get(issue.repoId);
    if (!readable(repo) || repo.archivedAt !== null) continue;
    if (!mayView(db, repo, issue, user)) continue;
    const pull = joinedMine.get(issue.id);
    if (issue.kind === "pull" && pull === undefined) continue;
    // A pull a pass gave up on and assigned to this person says why, and can go back.
    const reason = pull === undefined || issue.assigneeIsAgent ? undefined : passReasonOf(db, issue.id, issue.assigneeId!);
    // Whatever a person holds can go to the crew, not only what a pass gave up on.
    const back = issue.assigneeIsAgent ? undefined : hands.get(issue.id);
    out.push({
      kind: "assigned",
      id: `assigned:${issue.id}`,
      since: issue.updatedAt,
      repo,
      ...(pull === undefined ? { issue } : { pull }),
      who: issue.authorName,
      authorIsAgent: issue.authorIsAgent,
      ...(reason === undefined ? {} : { why: reason }),
      ...(back === undefined ? {} : { builder: back }),
      ...(pull !== undefined &&
      mineChecks.get(pull.id)?.state === "ok" &&
      reviewSummary(db, pull.id, pull.headOid).changesRequested === 0
        ? { canLand: true }
        : {}),
    });
  }
  return out;
}

/** The asks a repository makes that are not a pull's: a ceiling pause, a
 * parked issue, a planner's decline, a wave waiting for its nod. */
function repoAsksInto(
  db: Database,
  out: AskCandidate[],
  repos: readonly Repo[],
  byId: ReadonlyMap<string, Repo>,
): void {
  const crew = crewForRepos(
    db,
    repos.map((r) => r.id),
  );
  const spent = spentTodayForRepos(
    db,
    repos.map((r) => r.id),
  );
  // Only a ceiling pause is an ask — "nobody" and "no crew" are settings
  // problems, not a decision, so neither needs its own card.
  // A ceiling pause is today's: tomorrow it is a new one.
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  for (const repo of repos)
    if (isPausedAtCeiling(repo, crew, spent))
      out.push({
        kind: "paused",
        id: `paused:${repo.id}`,
        since: today,
        repo,
        who: "the crew",
      });
  // An issue the breaker parked waits for a person's word.
  for (const p of breakerParked(
    db,
    repos.map((r) => r.id),
  )) {
    const issue = getIssueById(db, p.issueId);
    const repo = byId.get(p.repoId);
    // An autonomous repository's parked issue is the planner's (`parkedTwice`).
    if (issue && repo && repo.autonomy !== "autonomous")
      out.push({
        kind: "parked",
        id: `parked:${issue.id}`,
        since: p.at,
        repo,
        issue,
        who: "the crew",
      });
  }
  // A planner that declined the direction plans nothing more until a person
  // answers on the direction issue: the crew has gone quiet on purpose.
  for (const d of plannerDeclines(db, repos))
    out.push({
      kind: "declined",
      // The run, not the issue: each new decline is new, and pages once.
      id: `declined:${d.runId}`,
      since: d.at,
      repo: d.repo,
      issue: d.issue,
      who: "the planner",
      decline: { runId: d.runId, words: d.words },
    });
  // A wave the planner proposed waits for the owner's nod: one card each.
  for (const proposal of proposalsFor(db, repos.map((r) => r.id), "pending"))
    out.push({
      kind: "proposal",
      id: `proposal:${proposal.id}`,
      since: proposal.createdAt,
      repo: byId.get(proposal.repoId)!,
      proposal,
      who: getUserById(db, proposal.authorId)?.username ?? "the planner",
    });
}

/**
 * Score each candidate (`Consequence`). Labels and blocked work are read
 * once for the whole set, never per row.
 */
function consequencesOf(
  db: Database,
  asks: readonly AskCandidate[],
  now: number,
): Map<string, Consequence> {
  // What a pull says it closes is its author's free text: it counts only
  // when the author could have written the issue's labels themselves.
  // A person's pull reads its author once for the set, and whether they
  // write here once per repository and author.
  const authors = getUsersByIds(
    db,
    asks.flatMap((a) => (a.pull && !a.pull.authorIsAgent ? [a.pull.authorId] : [])),
  );
  const writes = new Map<string, boolean>();
  const trusted = (pull: Pull, repo: Repo): number[] => {
    if (!pull.authorIsAgent) {
      const author = authors.get(pull.authorId);
      const key = `${repo.id}:${pull.authorId}`;
      if (author !== undefined && !writes.has(key)) writes.set(key, canWrite(db, repo, author));
      if (author === undefined || !writes.get(key)) return [];
    }
    return closesFromBody(pull.body);
  };
  const closes = new Map(
    asks.flatMap((a) => (a.pull ? [[a.id, trusted(a.pull, a.repo)] as const] : [])),
  );
  const closed = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM issue WHERE repo_id = ?1 AND number IN (SELECT value FROM json_each(?2))",
  );
  const named = new Map(
    asks.map((a) => {
      const thing = a.pull ?? a.issue;
      const numbers = closes.get(a.id) ?? [];
      const ids =
        numbers.length === 0
          ? []
          : closed.all(a.repo.id, JSON.stringify(numbers)).map((r) => r.id);
      return [a.id, thing === undefined ? ids : [thing.id, ...ids]] as const;
    }),
  );
  // Labels are set by those who write: never a stranger's words.
  const labels = labelsForIssues(db, [...new Set([...named.values()].flat())]);
  const blocks = db.query<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM issue_dependency d JOIN issue i ON i.id = d.blocked_by_id
     JOIN issue w ON w.id = d.issue_id
     WHERE i.repo_id = ?1 AND w.state = 'open' AND i.number IN (SELECT value FROM json_each(?2))`,
  );
  const out = new Map<string, Consequence>();
  for (const a of asks) {
    const thing = a.pull ?? a.issue;
    const age = Math.min(
      Math.max(0, (now - Date.parse(a.since)) / 86_400_000),
      9.9,
    ) / 10;
    let c = KIND_TIER[a.kind];
    if (thing !== undefined) {
      // Security is a label on the thing, or on what it closes.
      const security = (named.get(a.id) ?? []).some((id) =>
        (labels.get(id) ?? []).some((l) => /security/i.test(l.name)),
      );
      // What the thing would close, and what waits for that.
      const numbers = a.pull ? (closes.get(a.id) ?? []) : [thing.number];
      const waiting =
        numbers.length === 0
          ? 0
          : (blocks.get(a.repo.id, JSON.stringify(numbers))?.n ?? 0);
      if (security) c = { score: 100, why: "security" };
      else if (waiting > 0 && c.score < 60)
        c = {
          score: 60,
          why: `${waiting} other ${waiting === 1 ? "issue waits" : "issues wait"} for it`,
        };
    }
    out.set(a.id, { score: c.score + age, why: c.why });
  }
  return out;
}

/** The row an ask collapses into: one kind in one repository. */
const groupId = (a: { kind: DecisionKind; repo: Repo; id: string }): string =>
  // Work assigned to you is each its own row: they share no decision.
  a.kind === "assigned" || a.kind === "waiting" || a.kind === "proposal" ? a.id : `${a.kind}:${a.repo.id}`;

/**
 * The asks the viewer has not set aside: a muted repository's asks are all
 * out (they still exist, and `repoAsks` still counts them); a dismissal — of the ask, or of
 * the row it collapsed into — holds until the ask's cause is newer than it
 * (a check ran again, it was parked again, a new day's pause).
 */
function notDismissed<T extends AskCandidate>(
  db: Database,
  user: User,
  asks: readonly T[],
  given?: Chips,
): T[] {
  const muted = mutedRepos(db, user.id);
  const dismissed = askDismissals(db, user.id);
  const chips = given ?? chipsOf(db, user.id);
  // A change waiting on review is a `pull`; anything else is a decision.
  // The author is the actor the person chip names.
  const chipped = (a: T): boolean =>
    chipHides(chips, {
      kind: a.pull !== undefined ? "pull" : "decision",
      actorId: a.pull?.authorId ?? a.issue?.authorId ?? null,
    });
  const holds = (id: string, since: string): boolean =>
    (dismissed.get(`ask:${id}`) ?? "") > since;
  // A hand-over the decider or the standing rule set aside is closed for
  // everyone it asks, not for one viewer: the ledger holds it.
  const setAside = (a: T): boolean => {
    if (a.kind !== "parked" || a.issue === undefined) return false;
    const last = latestDecision(db, a.issue.id, "hand");
    return last?.outcome === "set_aside" && last.createdAt >= a.since;
  };
  return asks.filter(
    (a) =>
      !muted.has(a.repo.id) &&
      !chipped(a) &&
      !holds(a.id, a.since) &&
      !holds(groupId(a), a.since) &&
      !setAside(a),
  );
}

/** Asks as the rows a person sees: the same kind in the same repository is one. */
export interface AskRow<T> {
  /** The ask's own id when it is alone, else the row's (`kind:repoId`). */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly repo: Repo;
  readonly items: readonly T[];
  /** The weightiest ask's: what the row ranks by. */
  readonly consequence: Consequence;
}

/**
 * Asks as rows, most consequential first: a row ranks by its weightiest
 * ask, and the asks inside it the same way.
 */
export function askRows<
  T extends { id: string; kind: DecisionKind; repo: Repo; consequence: Consequence },
>(
  unranked: readonly T[],
): AskRow<T>[] {
  const asks = [...unranked].sort(
    (a, b) => b.consequence.score - a.consequence.score,
  );
  const rows = new Map<string, T[]>();
  for (const a of asks) {
    const key = groupId(a);
    const row = rows.get(key);
    if (row) row.push(a);
    else rows.set(key, [a]);
  }
  return [...rows.entries()].map(([key, items]) => ({
    id: items.length === 1 ? items[0]!.id : key,
    kind: items[0]!.kind,
    repo: items[0]!.repo,
    items,
    consequence: items[0]!.consequence,
  }));
}

export type Scored = AskCandidate & {
  readonly consequence: Consequence;
  readonly waiting: WaitingFor;
};

/** What a candidate waits for, from facts already on it plus the sweep's conflicts. */
function waitingOf(db: Database, user: User | undefined, a: AskCandidate): WaitingFor {
  const about = a.pull ?? a.issue;
  return waitingFor({
    kind: a.kind,
    conflicts: a.pull ? conflictsOf(db, a.pull.id, a.pull.headOid) : 0,
    assignedToViewer: user !== undefined && about?.assigneeId === user.id,
    who: a.who,
  });
}

/** Every candidate for the viewer, scored, dismissed or not. */
export function scoredFor(
  db: Database,
  user: User | undefined,
  repos: readonly Repo[],
  now = Date.now(),
  only?: string,
): Scored[] {
  const asks = askCandidatesFor(db, user, repos, only);
  const scores = consequencesOf(db, asks, now);
  return asks.map((a) => ({
    ...a,
    consequence: scores.get(a.id)!,
    waiting: waitingOf(db, user, a),
  }));
}

/** The waves the viewer put aside with Later, oldest first, for the line that brings them back. */
export function putAsideWaves(db: Database, user: User): Proposal[] {
  const repos = listReposVisibleTo(db, user, { limit: 200, withoutArchived: true });
  const mine = ownerFactRepoIds(db, repos, user);
  return proposalsFor(db, repos.filter((r) => mine.has(r.id)).map((r) => r.id), "later");
}

/**
 * The viewer's muted repositories that hold asks right now: said on the
 * home, never silent, so a mute is always one tap from being taken back.
 */
export function silencedRepos(
  db: Database,
  user: User,
): Repo[] {
  const muted = mutedRepos(db, user.id);
  if (muted.size === 0) return [];
  const inMuted = [...getReposByIds(db, [...muted]).values()].filter((r) =>
    canRead(db, r, user),
  );
  const held = new Map<string, Repo>();
  for (const a of scoredFor(db, user, inMuted)) held.set(a.repo.id, a.repo);
  return [...held.values()];
}

/**
 * How many rows ask the viewer in this one repository, mute or no mute: the
 * repository's own page counts what its home leaves out.
 */
export function repoAsks(
  db: Database,
  user: User | undefined,
  repo: Repo,
): { count: number; muted: boolean } {
  if (!user) return { count: 0, muted: false };
  return {
    count: askRows(scoredFor(db, user, [repo])).length,
    muted: mutedRepos(db, user.id).has(repo.id),
  };
}

/** What asks the viewer now: candidates, less what they set aside. */
export function waitingOn(
  db: Database,
  user: User | undefined,
  repos: readonly Repo[],
  chips?: Chips,
): Scored[] {
  if (!user) return [];
  return notDismissed(db, user, scoredFor(db, user, repos), chips);
}

/** How an ask that is no longer asked ended, when nobody dismissed it. */
export function endOf(
  db: Database,
  viewerId: string,
  askId: string,
  raisedAt: string,
): Exclude<AskEnd, "dismissed"> {
  const [kind, what] = askId.split(":") as [DecisionKind, string];
  if (kind === "look" || kind === "review" || kind === "stopped" || kind === "handover" || kind === "waiting") {
    const pull = getIssueById(db, what);
    // Shipped or closed: someone decided. Held by the one it asked: they
    // answered "not yet". Still open otherwise: the cause went away.
    if (pull !== undefined && pull.state !== "open") return "acted";
    return getHold(db, what)?.heldBy === viewerId ? "acted" : "expired";
  }
  if (kind === "assigned") {
    const issue = getIssueById(db, what);
    return issue !== undefined && issue.state !== "open" ? "acted" : "expired";
  }
  if (kind === "parked") {
    const issue = getIssueById(db, what);
    if (issue === undefined) return "expired";
    if (issue.state !== "open") return "acted";
    const spoke = listComments(db, issue.id).some(
      (c) => c.createdAt > raisedAt && getUserById(db, c.authorId)?.kind === "user",
    );
    return spoke ? "acted" : "expired";
  }
  // A pause lifted the same day was a raised ceiling; a decline that ends
  // was answered (the planner only goes on after a person's word).
  if (kind === "paused")
    return raisedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? "acted"
      : "expired";
  return "acted";
}

/**
 * Bring the asks ledger (`core/ask_ledger.ts`) in line with what asks each
 * person who came to the forge lately — a signed-in session that has not
 * expired, or a phone to tell. A tick's work, never a request's.
 */
export function recordAskLedger(db: Database, now = new Date()): void {
  const at = now.toISOString();
  // Bounded, and in an order that keeps the people asks are for: whoever
  // has a crew working (on their own repository or their organisation's),
  // then site admins, then the most recently signed in. A wave of new
  // accounts can never push an owner out of their own figures.
  const people = db
    .query<{ id: string }, [string]>(
      `SELECT u.id AS id FROM user u
       WHERE u.is_agent = 0 AND u.kind = 'user' AND (
         EXISTS (SELECT 1 FROM session s WHERE s.user_id = u.id AND s.expires_at > ?1)
         OR EXISTS (SELECT 1 FROM user_setting t WHERE t.user_id = u.id AND t.key = 'notify_url' AND t.value <> ''))
       ORDER BY
         EXISTS (SELECT 1 FROM repo r JOIN repo_crew rc ON rc.repo_id = r.id
                 WHERE r.owner_id = u.id
                    OR r.owner_id IN (SELECT tm.org_id FROM team tm JOIN team_member m ON m.team_id = tm.id
                                      WHERE m.user_id = u.id)) DESC,
         u.is_admin DESC,
         (SELECT MAX(s.created_at) FROM session s WHERE s.user_id = u.id) DESC,
         u.id
       LIMIT 200`,
    )
    .all(at);
  for (const { id } of people) {
    const user = getUserById(db, id);
    if (!user) continue;
    const repos = listReposVisibleTo(db, user, { limit: 200, withoutArchived: true });
    const all = scoredFor(db, user, repos, now.getTime());
    const shown = notDismissed(db, user, all);
    const brief = (a: Scored) => ({ id: a.id, repoId: a.repo.id, kind: a.kind });
    syncAskLedger(
      db,
      user.id,
      all.map(brief),
      shown.map(brief),
      (askId, raisedAt) => endOf(db, user.id, askId, raisedAt),
      at,
    );
  }
}

/** One ask in a line, without its repository's name (the row adds that). */
function lineOf(c: AskCandidate): string {
  if (c.kind === "paused") return "is paused at its ceiling";
  if (c.kind === "assigned")
    return `"${c.pull?.title ?? c.issue?.title ?? ""}" is assigned to you${c.why === undefined ? "" : `: ${c.why}`}`;
  if (c.kind === "parked")
    return `the crew parked #${c.issue!.number} after three failed runs`;
  if (c.kind === "proposal")
    return `proposes "${c.proposal?.title ?? ""}" and waits for your nod`;
  if (c.kind === "declined")
    return "the planner declined the direction and waits for you";
  if (c.kind === "waiting") return `"${c.pull?.title ?? ""}" is ${c.why ?? "waiting"} for a person`;
  if (c.kind === "handover")
    return `"${c.pull?.title ?? ""}" had three reviews asking for changes and waits for you`;
  const title = c.pull?.title ?? "";
  if (c.kind === "review")
    return `"${title}" waits for your review: ${reviewWhy(c.reviewWait, reviewerPaused(c.repo))}`;
  return c.kind === "stopped"
    ? `the crew stopped on "${title}"`
    : `"${title}" is green, waiting for your look`;
}

/** Why an agent's change waits for a person's review, in a clause. */
export const reviewWhy = (wait: ReviewWait | undefined, paused = false): string =>
  `${reviewSays(wait, paused)}, since ${wait?.since.slice(0, 10) ?? "it went green"}`;

/** A collapsed row in a line: how many, and of what. */
export const ROW_PLURAL: Readonly<Record<DecisionKind, (n: number) => string>> = {
  look: (n) => `${n} green changes wait for your look`,
  review: (n) => `${n} agent changes wait for your review`,
  stopped: (n) => `the crew stopped on ${n} changes`,
  parked: (n) => `the crew parked ${n} issues after three failed runs`,
  handover: (n) => `${n} changes had three reviews asking for changes and wait for you`,
  waiting: (n) => `${n} changes have waited a day for a person`,
  declined: (n) => `the planner declined ${n} times and waits for you`,
  proposal: (n) => `${n} waves wait for your nod`,
  paused: (n) => `${n} pauses at the ceiling`,
  assigned: (n) => `${n} things assigned to you`,
};

/** Every kind has its own: a row never says "green changes" of something that is not one. */
const rowLine = (kind: DecisionKind, n: number): string => ROW_PLURAL[kind](n);

/** The anchor a row's card carries on the home (what needs you, `needsYouSection`), so a link can land on it. */
export const askAnchor = (id: string): string => id.replace(/[^a-z0-9-]/g, "-");

/**
 * What asks `user` right now, one row each — the panel's own candidates
 * (same visibility, same bounds, less what they dismissed), collapsed the
 * way the page collapses them, without the pictures. `items` are the ids
 * of the asks a row holds: what the phone's notifier compares from one
 * moment to the next, so a new ask under an old row is still news.
 */
export function askLinesFor(
  db: Database,
  user: User,
  chips?: Chips,
): {
  id: string;
  line: string;
  kind: DecisionKind;
  repoId: string;
  /** The app, as owner/name: what `say` and `tell` take as `repo`. */
  repo: string;
  /** Where a person decides it: the pull or issue, or the row on the home. */
  link: string;
  /** The pull's or issue's number, for a row of one that is about one. */
  number?: number;
  /** Whether `number` is a pull's or an issue's. */
  numberOf?: "pull" | "issue";
  /** For a wave proposal: what it says, as plain text (the reader escapes it). */
  proposal?: { id: string; title: string; why: string; issues: string[] };
  items: string[];
  /** The decision, its options and what happens if nobody acts (`ASK_WORDS`). */
  words: AskWords;
  /** Why it ranks where it does; rows come most consequential first. */
  consequence: Consequence;
  /** What the row waits for (the weightiest ask's), and on whom. */
  waitingFor: WaitingFor;
  /** For a row of one handed-over or long-waiting pull: why a person must decide. */
  why?: string;
  /** The crew's advice on it, when it wrote one. */
  recommendation?: Recommendation;
}[] {
  const repos = listReposVisibleTo(db, user, { limit: 200, withoutArchived: true });
  return askRows(waitingOn(db, user, repos, chips)).map((row) => {
    const base = `/${row.repo.ownerName}/${row.repo.name}`;
    const about = {
      id: row.id,
      kind: row.kind,
      repoId: row.repo.id,
      repo: `${row.repo.ownerName}/${row.repo.name}`,
      items: row.items.map((c) => c.id),
      words: ASK_WORDS[row.kind],
      consequence: row.consequence,
      waitingFor: row.items[0]!.waiting,
    };
    const only = row.items.length === 1 ? row.items[0]! : undefined;
    if (only?.why !== undefined) Object.assign(about, { why: only.why });
    if (only?.recommendation !== undefined) Object.assign(about, { recommendation: only.recommendation });
    if (only === undefined)
      return {
        ...about,
        line: `${row.repo.name}: ${rowLine(row.kind, row.items.length)}`,
        link: `/#${askAnchor(row.id)}`,
      };
    const line = `${row.repo.name}${only.kind === "paused" ? " " : ": "}${lineOf(only)}`;
    if (only.kind === "paused")
      return { ...about, line, link: `${base}/settings/autonomy` };
    if (only.proposal !== undefined)
      return {
        ...about,
        line,
        link: `/#${askAnchor(only.id)}`,
        proposal: {
          id: only.proposal.id,
          title: only.proposal.title,
          why: only.proposal.why,
          issues: issueTitles(only.proposal),
        },
      };
    if (only.pull === undefined && only.issue !== undefined)
      return {
        ...about,
        line,
        number: only.issue!.number,
        numberOf: "issue",
        link: `${base}/issues/${only.issue!.number}`,
      };
    return {
      ...about,
      line,
      number: only.pull!.number,
      numberOf: "pull",
      link: `${base}/pulls/${only.pull!.number}`,
    };
  });
}

/**
 * What the forge itself needs, for a site admin: each sentence of the
 * health answer (`/api/v1/health`) as one ask. Anyone else gets none — the
 * forge's standing is the admin's to read and nobody else's to know about.
 */
export function forgeNeedsFor(ctx: Ctx, user: User | undefined): Degraded[] {
  if (!user?.isAdmin) return [];
  return forgeVitals(ctx.app).degraded;
}

/**
 * How many things ask the viewer: the one number the studio header and the
 * asks page both show. It counts the rows the cards are made into
 * (`askRows` over `waitingOn`) plus the forge's own needs, so the two
 * cannot disagree.
 */
export function askCountFor(ctx: Ctx, user: User | undefined): number {
  if (!user) return 0;
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
  return (
    askRows(waitingOn(ctx.app.db, user, repos)).length +
    forgeNeedsFor(ctx, user).length
  );
}

/** The single sentence the asks page leads with, and the dashboard links with. */
export function askSentence(count: number): string {
  return count === 0
    ? "All fine"
    : `${count} ${count === 1 ? "thing needs" : "things need"} you`;
}

/**
 * What asks the viewer, as data: the rows most consequential first (each
 * with its decision, options and default), the forge's own needs for an
 * admin, and the week's measure of asks raised against acted on, dismissed
 * and gone by themselves. `GET /api/v1/asks` and the MCP's `asks` read this.
 */
export function asksAnswer(ctx: Ctx, user: User, chips?: Chips) {
  const set = reviewSet(ctx, user);
  return {
    // The very figures Home's line and /review show: `count` is live asks plus the forge's needs; `stale` are older than 30 days.
    waiting: { count: set.count, stale: set.stale.length },
    rows: askLinesFor(ctx.app.db, user, chips),
    forge: forgeNeedsFor(ctx, user).map((d) => needLine(d)),
    measure: { days: ASKS_WINDOW_DAYS, ...askMeasureWeek(ctx.app.db, user.id) },
  };
}

/**
 * The asks an issue or pull can raise, as dismissal items: a pull is looked
 * at or stopped on, an issue is parked, and either can be assigned to you. What a bulk dismissal records, and
 * what its undo takes back (`fleet/verbs.ts`).
 */
export function askItemsOf(issue: Issue): string[] {
  return issue.kind === "pull"
    ? [
        `ask:look:${issue.id}`,
        `ask:review:${issue.id}`,
        `ask:stopped:${issue.id}`,
        `ask:handover:${issue.id}`,
        `ask:waiting:${issue.id}`,
        `ask:assigned:${issue.id}`,
      ]
    : [`ask:parked:${issue.id}`, `ask:assigned:${issue.id}`];
}

/**
 * Whether the viewer's dismissal of this issue's ask still holds: one newer
 * than its cause — the pull's latest check, or the issue's latest park.
 */
export function askDismissedBy(db: Database, viewerId: string, issue: Issue): boolean {
  const dismissed = askDismissals(db, viewerId);
  const at = askItemsOf(issue)
    .map((item) => dismissed.get(item) ?? "")
    .reduce((a, b) => (a > b ? a : b), "");
  if (at === "") return false;
  const cause =
    issue.kind === "pull"
      ? pullCause(db, issue)
      : (db
          .query<{ at: string | null }, [string, string, string, string]>(
            "SELECT MAX(created_at) AS at FROM comment WHERE issue_id = ?1 AND body IN (?2, ?3, ?4)",
          )
          .get(issue.id, ...WAITING_NOTES)?.at ?? issue.createdAt);
  return at > cause;
}

/** A pull ask's cause, as `askCandidatesFor` dates it: its green check, or merging again. */
function pullCause(db: Database, issue: Issue): string {
  const check = latestRunsForIssues(db, [issue.id]).get(issue.id)?.createdAt ?? issue.createdAt;
  const pull = getPull(db, issue.repoId, issue.number);
  const again = pull ? (mergesAgainSince(db, pull.id, pull.headOid) ?? "") : "";
  return check > again ? check : again;
}

/**
 * Ask ids, as `GET /api/v1/asks` hands them out (a row's `items`), to the
 * issues and pulls a bulk action works on — only those that ask the viewer
 * now, whether or not they dismissed them. The rest are named with why:
 * a ceiling and a planner's decline are decided where they live.
 */
export function askTargetsFor(
  db: Database,
  user: User,
  items: readonly string[],
): { issueIds: string[]; refused: { item: string; reason: string }[] } {
  const asks = new Map(
    askCandidatesFor(db, user, listReposVisibleTo(db, user, { limit: 200, withoutArchived: true })).map(
      (a) => [a.id, a],
    ),
  );
  const issueIds: string[] = [];
  const refused: { item: string; reason: string }[] = [];
  // `issue:<id>` names an issue or pull assigned to the viewer. The home no
  // longer hands it out (its assigned rows are `assigned:<id>`); it is kept
  // because the API and the MCP's `asks_act` document it to their callers.
  const assigned = new Map(
    listAssignedTo(db, user.id, 200).map((i) => [`issue:${i.id}`, i]),
  );
  for (const item of new Set(items)) {
    const ask = asks.get(item);
    const mine = assigned.get(item);
    if (mine !== undefined) issueIds.push(mine.id);
    else if (ask === undefined) refused.push({ item, reason: NO_LONGER_ASKS });
    else if (ask.kind === "paused")
      refused.push({ item, reason: "a ceiling is raised in the app's settings" });
    else if (ask.kind === "proposal")
      refused.push({ item, reason: "a proposal is approved, redirected or put aside on its card" });
    else if (ask.kind === "declined")
      refused.push({ item, reason: "a planner's decline is answered on its issue" });
    else issueIds.push((ask.pull ?? ask.issue)!.id);
  }
  return { issueIds: [...new Set(issueIds)], refused };
}
