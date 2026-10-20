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
 *   and it takes that slot.
 * - After two such runs ended without a push (the head still carries the
 *   approval, so neither pushed), it is handed to a person: assigned to
 *   whoever turned autonomy on, so it is on their review list, with the
 *   conflict named. Never retried forever, and never closed: the work was
 *   approved.
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
import { activeRunFor } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { createLog } from "../kernel/log.ts";
import { CHECK_FAILED_LIMIT, lastHumanWord, queueAgentRun } from "./dispatch.ts";
import { HANDOVER_NOTE } from "./guard.ts";
import { pickBuilder } from "./route.ts";

const log = createLog("crew");

/** What the pass did with one approved, conflicted pull. */
export type FinishMove =
  | { readonly pull: number; readonly did: "queued update"; readonly builder: string }
  | { readonly pull: number; readonly did: "in flight" }
  | { readonly pull: number; readonly did: "handed to a person"; readonly to: string }
  | { readonly pull: number; readonly did: "not moved"; readonly why: string };

/** Whether the pull's head carries an approval and no change requested: what lands once it merges. */
export function approvedOnHead(db: Database, pull: Pull): boolean {
  const seen = reviewSummary(db, pull.id, pull.headOid);
  return seen.approvals > 0 && seen.changesRequested === 0;
}

/** The tick line's two numbers: pulls being brought up to date, and the rest still waiting. */
export function finishFields(moves: readonly FinishMove[]): { finishing?: number; conflict?: string } {
  const finishing = moves.filter((m) => m.did === "queued update" || m.did === "in flight").length;
  const waiting = moves.length - finishing;
  return {
    ...(finishing === 0 ? {} : { finishing }),
    ...(waiting === 0 ? {} : { conflict: `${waiting} waiting` }),
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
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return [];
  const moves: FinishMove[] = [];
  const builders = listCrewRoles(app.db, repo.id)
    .filter((c) => c.role === "builder")
    .map((c) => c.agent);
  const open = listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 50 });
  const ids = new Set(open.map((p) => p.id));
  for (const id of read.keys()) if (!ids.has(id)) read.delete(id);
  let slots = free;
  for (const pull of open.sort((a, b) => a.number - b.number)) {
    if (!pull.authorIsAgent || pull.mergedAt !== null) continue;
    if (getHold(app.db, pull.id) !== undefined) continue;
    if (!approvedOnHead(app.db, pull)) continue;
    const files = await conflictOf(app, repo, pull);
    if (files === undefined) continue;
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    const move = finishOne(app, repo, pull, issue, files, builders, slots);
    if (move.did === "queued update") slots--;
    moves.push(move);
    say(repo, pull, move);
  }
  return moves;
}

function finishOne(
  app: App,
  repo: Repo,
  pull: Pull,
  issue: Issue,
  files: readonly string[],
  builders: readonly Agent[],
  slots: number,
): FinishMove {
  const not = (why: string): FinishMove => ({ pull: pull.number, did: "not moved", why });
  if (activeRunFor(app.db, "agent", pull.id) !== undefined) return { pull: pull.number, did: "in flight" };
  // A person's name on it is a person holding it — after a hand-over too.
  if (issue.assigneeId !== null && getAgent(app.db, issue.assigneeId) === undefined)
    return not("a person has it");
  const builder =
    builders.find((b) => b.user.id === issue.assigneeId) ??
    builders.find((b) => b.user.id === issue.authorId) ??
    pickBuilder(issue, builders, new Map());
  if (builder === undefined) return not("no builder on the crew");
  if (failedUpdates(app, issue, builder) >= CHECK_FAILED_LIMIT) return handOver(app, repo, pull, issue, files);
  if (slots <= 0) return not("waits for a builder slot");
  const run = queueAgentRun(app, repo, issue, builder, "conflict", undefined, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: `main moved: ${files.join(", ")}`,
  });
  if (run === undefined) return not(`${builder.user.username}'s run was not queued (ceiling or breaker)`);
  return { pull: pull.number, did: "queued update", builder: builder.user.username };
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
  const not = (why: string): FinishMove => ({ pull: pull.number, did: "not moved", why });
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
  const where = { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number };
  const key = `${repo.id}:${pull.number}`;
  if (move.did === "queued update") {
    said.delete(key);
    log.info("approved pull conflicts: brought up to date first", { ...where, builder: move.builder });
    return;
  }
  if (move.did !== "not moved") return;
  const line = `${pull.headOid}:${move.why}`;
  if (said.get(key) === line) return;
  said.set(key, line);
  log.info(`approved pull conflicts: not moved, ${move.why}`, where);
}
