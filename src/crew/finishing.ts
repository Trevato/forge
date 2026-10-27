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
 *   the builder who can push its branch — the owner of the fork it lives
 *   in, else its author, else the agent on it, else any builder — and it
 *   takes that slot. When that builder already has a run in flight, the
 *   update queues behind it: lent to another builder (#6140) it could
 *   never push, and failed every time (#7006).
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
 * Every open pull is read, not the newest page, and one that is not a
 * candidate at all is logged once per reason too, as
 * `finishing: drop pull=N why="…"`; the pass's entry is logged when what
 * it reads changes, and with no candidate the tick line still says
 * `finishing="0 candidates of N open"` (#6263).
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
import { listOpenPulls, pullDir, type Pull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { reviewSummary } from "../core/reviews.ts";
import { activeRunFor, listActive } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { committedAt } from "../git/read.ts";
import { createLog } from "../kernel/log.ts";
import { noteWaitingToFinish, rebaseLaneSays } from "../flow/conflicted.ts";
import { type ConflictLane, readConflictRoom } from "./conflict_room.ts";
import { CHECK_FAILED_LIMIT, lastHumanWord, queueAgentRun } from "./dispatch.ts";
import { HANDOVER_NOTE } from "./guard.ts";
import { interruptionOf } from "./interrupted.ts";
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

/** One finishing pass: what it did with each candidate, and how many open pulls it read. */
export interface FinishPass {
  readonly moves: FinishMove[];
  readonly open: number;
}

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
  open?: number,
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
      ? open === undefined
        ? {}
        : { finishing: `0 candidates of ${open} open` }
      : { finishing: `queued ${queued}, in flight ${inFlight}, skipped ${skipped}${skipped === 0 ? "" : `: ${reasons}`}` }),
    ...(words === null ? {} : { lane: words }),
  };
}

/**
 * Pull id → the tips git last read, the files in conflict (null: clean or
 * nothing to add), and when the base tip was committed.
 */
const read = new Map<string, { key: string; files: string[] | null; movedAt?: string }>();

/** A pull's conflict with its base: the files, and when the base last moved. */
interface Conflict {
  readonly files: string[];
  readonly movedAt?: string;
}

/** The pull's conflict with its base; undefined when it merges. */
async function conflictOf(app: App, repo: Repo, pull: Pull): Promise<Conflict | undefined> {
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
    const files = !reading.ok && reading.error.kind === "conflict" ? reading.error.files : null;
    // A new base is a new chance: failed updates count from when it moved (#6263).
    const movedAt = files === null ? undefined : await committedAt(dir, baseTip);
    seen = { key, files, ...(movedAt === undefined ? {} : { movedAt }) };
    read.set(pull.id, seen);
  }
  return seen.files === null ? undefined : { files: seen.files, ...(seen.movedAt === undefined ? {} : { movedAt: seen.movedAt }) };
}

/**
 * Bring every approved, conflicted crew pull in `repo` up to date, taking
 * at most `free` builder slots. Returns what happened to each, oldest
 * pull first.
 */
export async function finishApproved(app: App, repo: Repo, free: number): Promise<FinishPass> {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) {
    enter(repo, "autonomy is off");
    noteWaitingToFinish(app.db, repo.id, []);
    return { moves: [], open: 0 };
  }
  const moves: FinishMove[] = [];
  const builders = listCrewRoles(app.db, repo.id)
    .filter((c) => c.role === "builder")
    .map((c) => c.agent);
  // Every open pull, oldest first: the newest page alone left the old,
  // approved, conflicted ones unread and unsaid (#6263).
  const open = listOpenPulls(app.db, repo.id);
  enter(repo, `open=${open.length} free=${free}`);
  const ids = new Set(open.map((p) => p.id));
  for (const id of read.keys()) if (!ids.has(id)) read.delete(id);
  let slots = free;
  let room = readConflictRoom(app.db);
  const load = new Map<string, number>();
  for (const run of listActive(app.db, "agent"))
    if (run.actorId !== null) load.set(run.actorId, (load.get(run.actorId) ?? 0) + 1);
  for (const pull of open) {
    // Not a candidate: said once per pull per reason, so a pull the pass
    // never reaches is never a mystery (#6263).
    if (!pull.authorIsAgent) {
      drop(repo, pull, "not the crew's");
      continue;
    }
    if (pull.mergedAt !== null) {
      drop(repo, pull, "merged");
      continue;
    }
    if (!approvedOnHead(app.db, pull)) {
      drop(repo, pull, "not approved on its head");
      continue;
    }
    const conflict = await conflictOf(app, repo, pull);
    if (conflict === undefined) {
      drop(repo, pull, "merges clean");
      continue;
    }
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") {
      drop(repo, pull, "not open");
      continue;
    }
    // From here every pull is approved and conflicted: one not brought up
    // to date says why, on its own line and on the tick line (#6237).
    const hold = getHold(app.db, pull.id);
    const move =
      hold !== undefined
        ? notMoved(pull, `held by ${hold.heldByName}`)
        : finishOne(app, repo, pull, issue, conflict, builders, load, slots, room);
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
    app.db,
    repo.id,
    moves.map((m) => ({
      repo: `${repo.ownerName}/${repo.name}`,
      number: m.pull,
      since,
      public: repo.visibility === "public",
    })),
  );
  return { moves, open: open.length };
}

function finishOne(
  app: App,
  repo: Repo,
  pull: Pull,
  issue: Issue,
  { files, movedAt }: Conflict,
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
  const forkOwner = getRepoById(app.db, pull.headRepoId)?.ownerId;
  const builder = ownBuilder(issue, builders, load, forkOwner);
  if (builder === undefined) return not(NO_BUILDER_ON_CREW);
  if (failedUpdates(app, issue, builder, movedAt) >= CHECK_FAILED_LIMIT) return handOver(app, repo, pull, issue, files);
  if (slots <= 0) return not(WAITS_FOR_BUILDER_SLOT);
  if (room <= 0) return not("waits for room in the check lane");
  const run = queueAgentRun(app, repo, issue, builder, "conflict", undefined, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: `main moved: ${files.join(", ")}`,
  });
  if (run === undefined) return not(`${builder.user.username}'s run was not queued (ceiling or breaker)`);
  return { pull: pull.number, did: "queued update", builder: builder.user.username };
}

/**
 * The pull's own builder, the one who can push its branch: the owner of the
 * fork it lives in, else its author, else the agent on it, else the builder
 * with least in flight. Busy or not, it is theirs (#7006).
 */
export function ownBuilder(
  issue: Issue,
  builders: readonly Agent[],
  load: ReadonlyMap<string, number>,
  forkOwner?: string,
): Agent | undefined {
  return (
    builders.find((b) => b.user.id === forkOwner) ??
    builders.find((b) => b.user.id === issue.authorId) ??
    builders.find((b) => b.user.id === issue.assigneeId) ??
    pickBuilder(issue, builders, load)
  );
}

/**
 * Conflict runs that ended since a person last spoke on the pull and since
 * its base last moved. Each one reached the agent and left the approved
 * head as it was, so none of them pushed. A run the forge cut short — a
 * network error, a clone or checkout that failed, a restart — never reached
 * the agent and is no attempt (`interrupted.ts`); a new base is a new
 * chance (#6263).
 */
function failedUpdates(app: App, issue: Issue, builder: Agent, movedAt?: string): number {
  const spoke = lastHumanWord(app, issue, builder);
  const since = movedAt !== undefined && movedAt > spoke ? movedAt : spoke;
  // Read row by row, so a run recorded before its words were known as an
  // interruption (a bare `checkout failed: …`) is not counted either.
  return app.db
    .query<{ summary: string | null }, [string, string]>(
      `SELECT summary FROM run
        WHERE kind = 'agent' AND reason = 'conflict' AND issue_id = ?1
          AND created_at > ?2 AND state IN ('ok','failed')`,
    )
    .all(issue.id, since)
    .filter(({ summary }) => !summary?.startsWith("skipped: ") && interruptionOf(summary ?? "") === undefined).length;
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

/** What each repository's pass last said it read, so its entry is said when that changes. */
const entered = new Map<string, string>();

function enter(repo: Repo, what: string): void {
  if (entered.get(repo.id) === what) return;
  entered.set(repo.id, what);
  log.info("finishing: pass", { repo: `${repo.ownerName}/${repo.name}`, read: what });
}

/** A pull that is not an approved, conflicted crew pull: said once per head and reason. */
function drop(repo: Repo, pull: Pull, why: string): void {
  const key = `${repo.id}:${pull.number}`;
  const line = `${pull.headOid}:${why}`;
  if (said.get(key) === line) return;
  said.set(key, line);
  log.info("finishing: drop", { pull: pull.number, why, repo: `${repo.ownerName}/${repo.name}` });
}

function say(repo: Repo, pull: Pull, move: FinishMove): void {
  const where = `${repo.ownerName}/${repo.name}`;
  const key = `${repo.id}:${pull.number}`;
  if (move.did === "queued update") {
    said.delete(key);
    log.info("approved pull conflicts: brought up to date first", {
      repo: where,
      pull: pull.number,
      builder: move.builder,
    });
    return;
  }
  if (move.did !== "not moved") return;
  const line = `${pull.headOid}:${move.why}`;
  if (said.get(key) === line) return;
  said.set(key, line);
  log.info("finishing: skip", { pull: pull.number, why: move.why, repo: where });
}
