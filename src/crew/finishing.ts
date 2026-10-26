/**
 * Finish before starting (#3682): an approved pull that no longer merges
 * is nearly done work, and it is brought up to date before any new issue
 * takes a builder slot.
 *
 * Every tick, first of the passes that spend slots, for each open crew
 * pull approved on its head with no change requested that conflicts with
 * its base:
 *
 * - With a run already in flight on it, it is finishing: nothing more.
 * - With a slot free, a conflict run (the #2039 resolver brief: merge the
 *   base, resolve keeping both intents, re-run the check) is queued for
 *   its builder — the agent on it, else its author, else any builder —
 *   and it takes that slot. When that builder already has a run in
 *   flight, the run goes to an idle builder instead, round-robin, so one
 *   busy agent holding many pulls does not bring them up to date one at
 *   a time (#6140); the run's agent is who rebased, and the log names
 *   whose pull it was.
 * - Its push is a check, so it also waits for room in the check lane, as
 *   the conflict sweep's runs do (`conflict_room.ts`): a landing that
 *   conflicts ten approved pulls at once must not put ten checks in the
 *   lane together (#4784).
 * - After two such runs ended without a push (the head still carries the
 *   approval, so neither pushed), it is handed to a person: assigned to
 *   whoever turned autonomy on, so it is on their review list, with the
 *   conflict named. Never retried forever, and never closed: the work was
 *   approved.
 * - Held, it is left as it is, and counted conflicted on the lane.
 *
 * Each one not brought up to date is logged once per reason as
 * `finishing: skip pull=N why="…"`, and the tick line tallies them:
 * `finishing="queued Q, in flight F, skipped S: <why>×k, …"` (#6237).
 *
 * Changes requested come after (`requested.ts`), then new issues
 * (`driveRepo`). The conflict sweep and the green sweep leave approved
 * pulls to this pass (`approvedOnHead`).
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, assignIssue } from "../actions/issues.ts";
import { getAgent, listCrewRoles, type Agent } from "../core/agents.ts";
import { getHold } from "../core/holds.ts";
import { getIssueById, type Issue } from "../core/issues.ts";
import { listPulls, pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { reviewSummary } from "../core/reviews.ts";
import { activeRunFor, listActive } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { createLog } from "../kernel/log.ts";
import { noteWaitingToFinish, rebaseLaneSays } from "../flow/conflicted.ts";
import { type ConflictLane, readConflictRoom } from "./conflict_room.ts";
import { CHECK_FAILED_LIMIT, lastHumanWord, queueAgentRun } from "./dispatch.ts";
import { HANDOVER_NOTE } from "./guard.ts";
import { pickBuilder } from "./route.ts";
import { NO_BUILDER_ON_CREW, WAITS_FOR_BUILDER_SLOT } from "./words.ts";

const log = createLog("crew");

/** What the pass did with one approved, conflicted pull. */
export type FinishMove =
  | {
      readonly pull: number;
      readonly did: "queued update";
      readonly builder: string;
      /** The pull's own builder, when it was busy and another took the update. */
      readonly for?: string;
    }
  | { readonly pull: number; readonly did: "in flight" }
  | { readonly pull: number; readonly did: "handed to a person"; readonly to: string }
  | { readonly pull: number; readonly did: "not moved"; readonly why: string };

const notMoved = (pull: Pull, why: string): FinishMove => ({ pull: pull.number, did: "not moved", why });

/** Whether the pull's head carries an approval and no change requested: what lands once it merges. */
export function approvedOnHead(db: Database, pull: Pull): boolean {
  const seen = reviewSummary(db, pull.id, pull.headOid);
  return seen.approvals > 0 && seen.changesRequested === 0;
}

/** Why a pull was not brought up to date this tick: the not-moved reason, or the hand-over. */
function skipWhy(move: FinishMove): string | undefined {
  if (move.did === "not moved") return move.why;
  if (move.did === "handed to a person") return "handed to a person";
  return undefined;
}

/**
 * The tick line's words: `queued Q, in flight F, skipped S: <why>×k, …` —
 * every approved conflicted pull, and why each skipped one was (#6237) —
 * and, given the lane, `conflicted N, rebasing M, room R`: this
 * repository's approved conflicted pulls against the forge-wide lane
 * (#6140), whenever any is conflicted or rebasing.
 */
export function finishFields(
  moves: readonly FinishMove[],
  lane?: ConflictLane,
): { finishing?: string; lane?: string } {
  const queued = moves.filter((m) => m.did === "queued update").length;
  const inFlight = moves.filter((m) => m.did === "in flight").length;
  const whys = new Map<string, number>();
  for (const move of moves) {
    const why = skipWhy(move);
    if (why !== undefined) whys.set(why, (whys.get(why) ?? 0) + 1);
  }
  const skipped = moves.length - queued - inFlight;
  const reasons = [...whys].map(([why, k]) => `${why}×${k}`).join(", ");
  const words =
    lane === undefined
      ? null
      : rebaseLaneSays({ conflicted: moves.length, rebasing: lane.runs + lane.checks, room: lane.room });
  return {
    ...(moves.length === 0
      ? {}
      : { finishing: `queued ${queued}, in flight ${inFlight}, skipped ${skipped}${skipped === 0 ? "" : `: ${reasons}`}` }),
    ...(words === null ? {} : { lane: words }),
  };
}

/** Pull id → the tips git last read, and the files in conflict (null: clean or nothing to add). */
const read = new Map<string, { key: string; files: string[] | null }>();

/** The files the pull conflicts on with its base; undefined when it merges. */
async function conflictOf(app: App, repo: Repo, pull: Pull): Promise<string[] | undefined> {
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const baseTip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
  if (baseTip === undefined) return undefined;
  // Git is asked once per pair of tips; until one moves, the answer stands.
  const key = `${pull.headOid}:${baseTip}`;
  let seen = read.get(pull.id);
  if (seen?.key !== key) {
    // A clean merge is nothing to do here, and one that leaves the base's
    // own tree is superseded, which the conflict sweep closes.
    const reading = await mergeable(dir, baseTip, pull.headOid);
    seen = { key, files: !reading.ok && reading.error.kind === "conflict" ? reading.error.files : null };
    read.set(pull.id, seen);
  }
  return seen.files ?? undefined;
}

/**
 * Bring every approved, conflicted crew pull in `repo` up to date, taking
 * at most `free` builder slots. Returns what happened to each, oldest
 * pull first.
 */
export async function finishApproved(app: App, repo: Repo, free: number): Promise<FinishMove[]> {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) {
    noteWaitingToFinish(repo.id, []);
    return [];
  }
  const moves: FinishMove[] = [];
  const builders = listCrewRoles(app.db, repo.id)
    .filter((c) => c.role === "builder")
    .map((c) => c.agent);
  const open = listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 50 });
  const ids = new Set(open.map((p) => p.id));
  for (const id of read.keys()) if (!ids.has(id)) read.delete(id);
  let slots = free;
  let room = readConflictRoom(app.db);
  const load = new Map<string, number>();
  for (const run of listActive(app.db, "agent"))
    if (run.actorId !== null) load.set(run.actorId, (load.get(run.actorId) ?? 0) + 1);
  for (const pull of open.sort((a, b) => a.number - b.number)) {
    if (!pull.authorIsAgent || pull.mergedAt !== null) continue;
    if (!approvedOnHead(app.db, pull)) continue;
    const files = await conflictOf(app, repo, pull);
    if (files === undefined) continue;
    // From here every pull is approved and conflicted: one not brought up
    // to date says why, on its own line and on the tick line (#6237).
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    const hold = getHold(app.db, pull.id);
    const move =
      hold !== undefined
        ? notMoved(pull, `held by ${hold.heldByName}`)
        : finishOne(app, repo, pull, issue, files, builders, load, slots, room);
    if (move.did === "queued update") {
      slots--;
      room--;
      const by = builders.find((b) => b.user.username === move.builder)!.user.id;
      load.set(by, (load.get(by) ?? 0) + 1);
    }
    moves.push(move);
    say(repo, pull, move);
  }
  const since = new Date().toISOString();
  noteWaitingToFinish(
    repo.id,
    moves.map((m) => ({
      repo: `${repo.ownerName}/${repo.name}`,
      number: m.pull,
      since,
      public: repo.visibility === "public",
    })),
  );
  return moves;
}

function finishOne(
  app: App,
  repo: Repo,
  pull: Pull,
  issue: Issue,
  files: readonly string[],
  builders: readonly Agent[],
  load: ReadonlyMap<string, number>,
  slots: number,
  room: number,
): FinishMove {
  const not = (why: string): FinishMove => notMoved(pull, why);
  if (activeRunFor(app.db, "agent", pull.id) !== undefined) return { pull: pull.number, did: "in flight" };
  // A person's name on it is a person holding it — after a hand-over too.
  if (issue.assigneeId !== null && getAgent(app.db, issue.assigneeId) === undefined)
    return not("a person has it");
  const own = ownBuilder(issue, builders, load);
  if (own === undefined) return not(NO_BUILDER_ON_CREW);
  // Two failed updates are counted against the pull's own builder, whoever ran them.
  const builder = (slots > 0 && room > 0 ? lentBuilder(own, builders, load) : undefined) ?? own;
  if (failedUpdates(app, issue, own) >= CHECK_FAILED_LIMIT) return handOver(app, repo, pull, issue, files);
  if (slots <= 0) return not(WAITS_FOR_BUILDER_SLOT);
  if (room <= 0) return not("waits for room in the check lane");
  const run = queueAgentRun(app, repo, issue, builder, "conflict", undefined, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: `main moved: ${files.join(", ")}`,
  });
  if (run === undefined) return not(`${builder.user.username}'s run was not queued (ceiling or breaker)`);
  return {
    pull: pull.number,
    did: "queued update",
    builder: builder.user.username,
    ...(builder === own ? {} : { for: own.user.username }),
  };
}

/** The pull's own builder: the agent on it, else its author, else the builder with least in flight. */
export function ownBuilder(
  issue: Issue,
  builders: readonly Agent[],
  load: ReadonlyMap<string, number>,
): Agent | undefined {
  return (
    builders.find((b) => b.user.id === issue.assigneeId) ??
    builders.find((b) => b.user.id === issue.authorId) ??
    pickBuilder(issue, builders, load)
  );
}

/** Whose turn it is among the idle builders, kept across ticks so lent updates go round. */
let turn = 0;

/**
 * The builder who takes an update when `own` already has a run in flight:
 * the next idle builder, round-robin by name (#6140). Undefined when `own`
 * is idle or every builder is busy: then the update is `own`'s.
 */
export function lentBuilder(
  own: Agent,
  builders: readonly Agent[],
  load: ReadonlyMap<string, number>,
): Agent | undefined {
  if ((load.get(own.user.id) ?? 0) === 0) return undefined;
  const idle = builders
    .filter((b) => (load.get(b.user.id) ?? 0) === 0)
    .sort((a, b) => a.user.username.localeCompare(b.user.username));
  if (idle.length === 0) return undefined;
  return idle[turn++ % idle.length];
}

/**
 * Conflict runs that ended since a person last spoke on the pull. Each one
 * left the approved head as it was, so none of them pushed.
 */
function failedUpdates(app: App, issue: Issue, builder: Agent): number {
  return app.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM run
        WHERE kind = 'agent' AND reason = 'conflict' AND issue_id = ?1
          AND created_at > ?2 AND state IN ('ok','failed')`,
    )
    .get(issue.id, lastHumanWord(app, issue, builder))!.n;
}

/** Two updates failed: the pull is the person's who turned autonomy on, with the conflict named. */
function handOver(app: App, repo: Repo, pull: Pull, issue: Issue, files: readonly string[]): FinishMove {
  const not = (why: string): FinishMove => notMoved(pull, why);
  const by = getUserById(app.db, repo.autonomyBy!);
  if (by === undefined) return not("nobody to hand it to");
  const assigned = assignIssue(app, by, repo, issue, by);
  if (!assigned.ok) return not(`could not hand it to ${by.username}: ${assigned.error}`);
  addComment(
    app,
    by,
    repo,
    issue,
    `${HANDOVER_NOTE} this pull is approved, but ${CHECK_FAILED_LIMIT} runs to bring it up to date with ${pull.baseBranch} ended without a push, so no more start here. Conflicting files: ${files.join(", ")}. Merge ${pull.baseBranch} into it, or say what to try and assign it back to the crew. (The forge posts this under your name; you did not write it.)`,
  );
  log.info("approved pull handed to a person: could not be brought up to date", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    to: by.username,
  });
  return { pull: pull.number, did: "handed to a person", to: by.username };
}

/** The last why-not said for a pull, so a stall is said once until it changes. */
const said = new Map<string, string>();

function say(repo: Repo, pull: Pull, move: FinishMove): void {
  const where = `${repo.ownerName}/${repo.name}`;
  const key = `${repo.id}:${pull.number}`;
  if (move.did === "queued update") {
    said.delete(key);
    log.info("approved pull conflicts: brought up to date first", {
      repo: where,
      pull: pull.number,
      builder: move.builder,
      ...(move.for === undefined ? {} : { for: move.for }),
    });
    return;
  }
  if (move.did !== "not moved") return;
  const line = `${pull.headOid}:${move.why}`;
  if (said.get(key) === line) return;
  said.set(key, line);
  log.info("finishing: skip", { pull: pull.number, why: move.why, repo: where });
}
