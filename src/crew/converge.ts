/**
 * Converging a fork with the parent it follows, when both have moved.
 *
 * A fork with nothing of its own just moves (`core/following.ts`). A fork
 * with its own work and a parent that merges cleanly is one mechanical
 * step (`takeUpdates`). What is left — the files both sides changed — is a
 * decision, and the crew makes the first draft of it: one issue on the
 * fork, "Take updates from <parent>", one builder, one run that merges the
 * staged parent branch, keeps the fork's direction where the two cannot
 * both be kept, and proposes the result as a pull on the fork. The pull
 * lands the way any pull on that fork lands: on green when the fork runs
 * on its own, after a look when it does not.
 *
 * Nothing here ever moves the fork's default branch by itself.
 */

import { requireAbility } from "../actions/roles.ts";
import { mayDirectCrew } from "./direct.ts";
import type { App } from "../app.ts";
import { openIssue } from "../actions/issues.ts";
import { listCrewRoles, type Agent } from "../core/agents.ts";
import {
  forkRelation,
  stageParent,
  takeUpdates,
  type ForkRelation,
} from "../core/following.ts";
import {
  addComment as insertComment,
  listIssues,
  setAssignee,
  setIssueState,
  type Issue,
} from "../core/issues.ts";
import { closesFromBody, listPulls, type Pull } from "../core/pulls.ts";
import { canWrite, getRepoById, listAllForks, type Repo } from "../core/repos.ts";
import { activeRunFor, cancelRun, listRuns } from "../core/runs.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { forkFollowMode } from "../core/fork_follow.ts";
import { getUserById, type User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { parkedCount } from "./autonomy.ts";
import { PARK_STRIKES } from "./parks.ts";
import { queueAgentRun } from "./dispatch.ts";
import { pickBuilder } from "./route.ts";

const log = createLog("converge");

/** The one issue a fork carries while its parent's updates are being taken. */
export function convergeTitle(parent: Repo): string {
  return `Take updates from ${parent.ownerName}/${parent.name}`;
}

export type Converge =
  /** A run is queued for this builder. */
  | { kind: "queued"; issue: Issue; agent: Agent }
  /** A run is already queued or running. */
  | { kind: "working"; issue: Issue; agent: Agent | undefined }
  /** The crew's proposal is open on the fork. */
  | { kind: "proposed"; issue: Issue; pull: Pull }
  /** The crew tried its limit; a person's word is needed. */
  | { kind: "parked"; issue: Issue }
  /** Not the crew's: in step, behind only, ahead only, or a clean merge. */
  | { kind: "nothing"; relation: ForkRelation | undefined }
  | { kind: "no_crew" }
  | { kind: "nobody" }
  /** The person asking may not direct the crew here (`direct.ts`). */
  | { kind: "forbidden" }
  /** A guest: the run is a member's to start, refused before anything is written. */
  | { kind: "not_member" }
  | { kind: "ceiling" }
  /** The fork is archived: no issue, no run, until it is woken. */
  | { kind: "archived" };

/** The fork's open converge issue, if the parent's updates are in hand. */
export function convergeIssue(
  app: App,
  fork: Repo,
  parent: Repo,
): Issue | undefined {
  const title = convergeTitle(parent);
  return listIssues(app.db, fork.id, { sealed: true, state: "open", limit: 200 }).find(
    (i) => i.title === title,
  );
}

/** The crew's open proposal for a converge issue: the pull that closes it. */
export function proposalFor(
  app: App,
  fork: Repo,
  issue: Issue,
): Pull | undefined {
  return listPulls(app.db, fork.id, { sealed: true, state: "open", limit: 100 }).find(
    (p) =>
      closesFromBody(p.body).includes(issue.number) ||
      new RegExp(`^[^/]+/${issue.number}(-|$)`).test(p.headBranch),
  );
}

/** Where a converge stands, without starting one. */
export function convergeState(
  app: App,
  fork: Repo,
  parent: Repo,
): Converge | undefined {
  const issue = convergeIssue(app, fork, parent);
  if (issue === undefined) return undefined;
  const pull = proposalFor(app, fork, issue);
  if (pull !== undefined) return { kind: "proposed", issue, pull };
  const active = activeRunFor(app.db, "agent", issue.id);
  if (active !== undefined) {
    const agent = listCrewRoles(app.db, fork.id).find(
      (c) => c.agent.user.id === active.actorId,
    )?.agent;
    return { kind: "working", issue, agent };
  }
  if (parkedCount(app, fork, issue.id) >= PARK_STRIKES) return { kind: "parked", issue };
  return { kind: "working", issue, agent: undefined };
}

function opener(
  app: App,
  fork: Repo,
  actor: User | undefined,
): User | undefined {
  if (actor !== undefined) return actor;
  const by =
    fork.autonomyBy === null ? undefined : getUserById(app.db, fork.autonomyBy);
  if (by !== undefined) return by;
  const owner = getUserById(app.db, fork.ownerId);
  return owner?.kind === "user" ? owner : undefined;
}

/**
 * Have the crew take the parent's updates into the fork. Idempotent: a
 * converge already in hand is reported, never doubled. A fork that needs
 * no crew for this (nothing to take, or a clean merge) is reported as
 * `nothing` and left to `takeUpdates`.
 */
export async function convergeFork(
  app: App,
  fork: Repo,
  parent: Repo,
  actor: User | undefined,
): Promise<Converge> {
  // Asked by someone, it is their run to start; asked by nobody, it is the
  // fork's own autonomy, which its owner turned on.
  if (actor !== undefined && !mayDirectCrew(app.db, fork, actor))
    return { kind: "forbidden" };
  if (actor !== undefined && !requireAbility(app, actor, "run_crew").ok)
    return { kind: "not_member" };
  // An archived fork is put away: no issue, no run, and it says so.
  if (fork.archivedAt !== null) return { kind: "archived" };
  const relation = await forkRelation(app, fork, parent);
  if (relation === undefined || relation.state !== "diverged" || relation.clean)
    return { kind: "nothing", relation };
  const inHand = convergeState(app, fork, parent);
  if (inHand !== undefined) return inHand;
  const builders = listCrewRoles(app.db, fork.id)
    .filter((c) => c.role === "builder")
    .map((c) => c.agent);
  if (builders.length === 0) return { kind: "no_crew" };
  const as = opener(app, fork, actor);
  if (as === undefined) return { kind: "nobody" };

  const staged = await stageParent(app, fork, parent);
  if (staged === undefined) {
    log.warn("could not stage the parent's branch", {
      fork: `${fork.ownerName}/${fork.name}`,
    });
    return { kind: "nothing", relation };
  }
  const files = relation.conflicts;
  const opened = openIssue(app, as, fork, {
    title: convergeTitle(parent),
    body: [
      `This repository follows ${parent.ownerName}/${parent.name}. Both have moved since they last agreed: ${relation.behind} change${relation.behind === 1 ? "" : "s"} there, ${relation.ahead} here, and ${files.length === 0 ? "git cannot merge them" : `${files.length === 1 ? "one file" : `${files.length} files`} changed on both sides: ${files.join(", ")}`}.`,
      "",
      `The parent's \`${parent.defaultBranch}\` is staged in this repository at \`refs/following/${parent.defaultBranch}\` (${staged.slice(0, 7)}). The crew merges it into a branch, keeps this repository's direction where the two cannot both be kept, and proposes the result here as a pull.`,
    ].join("\n"),
  });
  if (!opened.ok) return { kind: "nobody" };
  const issue = opened.value;

  const inFlight = new Map<string, number>();
  for (const r of listRuns(app.db, fork.id, { kind: "agent", limit: 50 }))
    if ((r.state === "running" || r.state === "queued") && r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const agent = pickBuilder(issue, builders, inFlight);
  if (agent === undefined) return { kind: "no_crew" };
  // The assignee is the agent so that what follows — feedback on the
  // proposal, a red check — reaches the same builder. Set without the
  // assignment event: that event starts an ordinary run, and this one is
  // queued with its own reason.
  const assigned = setAssignee(app.db, issue.id, agent.user.id) ?? issue;
  const run = queueAgentRun(app, fork, assigned, agent, "converge", actor?.id, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: `parent moved: ${files.join(", ")}`,
  });
  if (run === undefined) return { kind: "ceiling" };
  log.info("converging with the crew", {
    fork: `${fork.ownerName}/${fork.name}`,
    parent: `${parent.ownerName}/${parent.name}`,
    builder: agent.user.username,
    files: files.length,
  });
  return { kind: "queued", issue: assigned, agent };
}

/**
 * What a fork does on its own when its parent moves and it cannot simply
 * follow: with autonomy on, a clean merge is taken as the person the fork
 * acts as, and a conflict goes to the crew. With autonomy off, nothing —
 * the fork's page says what happened and offers both. Subscribed by the
 * crew; the answer is the unsubscribe.
 */
export function followDivergence(app: App): () => void {
  return app.bus.subscribe((event) => {
    if (event.kind !== "fork.diverged" || event.repoId === null) return;
    const fork = getRepoById(app.db, event.repoId);
    const parentId = event.payload["parentId"];
    const parent =
      typeof parentId === "string" ? getRepoById(app.db, parentId) : undefined;
    if (fork === undefined || parent === undefined) return;
    if (fork.autonomy === "off") return;
    // A fork that chose not to follow is never converged on its behalf.
    if (forkFollowMode(app.db, fork.id) === "dont-follow") return;
    diverged(app, fork, parent).catch((error) =>
      log.error("could not act on a diverged fork", {
        fork: `${fork.ownerName}/${fork.name}`,
        error: String(error),
      }),
    );
  });
}

async function diverged(app: App, fork: Repo, parent: Repo): Promise<void> {
  const relation = await forkRelation(app, fork, parent);
  if (relation === undefined || relation.state !== "diverged") return;
  if (relation.clean) {
    // Inside the walls: a merge git makes without a decision is taken
    // mechanically, and the check on the default branch says whether it
    // was right. Assisted forks wait for the person's click.
    if (fork.autonomy !== "autonomous" || fork.autonomyBy === null) return;
    const by = getUserById(app.db, fork.autonomyBy);
    if (by === undefined) return;
    const took = await takeUpdates(app, fork, parent, {
      id: by.id,
      ...commitIdentity(app.config, by),
    });
    log.info(took.ok ? "took the parent's updates" : "could not take updates", {
      fork: `${fork.ownerName}/${fork.name}`,
      ...(took.ok
        ? { to: took.value.to.slice(0, 7) }
        : { why: took.error.kind }),
    });
    return;
  }
  const outcome = await convergeFork(app, fork, parent, undefined);
  if (outcome.kind !== "queued" && outcome.kind !== "working")
    log.info("diverged, not converging", {
      fork: `${fork.ownerName}/${fork.name}`,
      why: outcome.kind,
    });
}

/**
 * Close a fork's converge issue once the parent's tip is inside the fork's
 * default branch: the work it asked for is done, whoever did it. A queued
 * run for it is cancelled; one already running finishes on its own and
 * finds the issue closed. The comment names both commits. Returns whether
 * an issue was closed.
 */
export async function settleConverge(
  app: App,
  fork: Repo,
  parent: Repo,
  /** Whoever moved the fork's branch (a merge, a push): the only name the close may be said under. */
  by?: User,
): Promise<boolean> {
  const issue = convergeIssue(app, fork, parent);
  if (issue === undefined) return false;
  const relation = await forkRelation(app, fork, parent);
  if (relation === undefined) return false;
  if (relation.state !== "synced" && relation.state !== "ahead") return false;
  if (relation.parentTip === "") return false;
  const holder =
    relation.state === "synced"
      ? relation.forkTip
      : await holdingCommit(app, fork, relation);
  const parentName = `${parent.ownerName}/${parent.name}`;
  const body = `${parentName}'s \`${parent.defaultBranch}\` at ${relation.parentTip.slice(0, 7)} is already in \`${fork.defaultBranch}\`, held by ${holder.slice(0, 7)}. Nothing is left to take, so this is closed and no run is needed.`;
  for (const run of listRuns(app.db, fork.id, { kind: "agent", limit: 50 }))
    if (run.issueId === issue.id && run.state === "queued")
      cancelRun(app.db, run.id, "parent's tip already in the fork");
  const closed = setIssueState(app.db, issue.id, "closed", "done");
  if (closed === undefined) return false;
  // Said as whoever moved the branch, and only if they may write here; with
  // none (the tick) nothing is said as the issue's author, who did not act.
  const said =
    by !== undefined && canWrite(app.db, fork, by)
      ? insertComment(app.db, { issueId: issue.id, authorId: by.id, body })
      : undefined;
  app.bus.append({
    kind: "issue.closed",
    repoId: fork.id,
    ...(by === undefined ? {} : { actorId: by.id }),
    payload: { number: issue.number, reason: "done" },
  });
  if (said?.ok)
    app.bus.append({
      kind: "issue.commented",
      repoId: fork.id,
      actorId: said.value.authorId,
      payload: { number: issue.number, body, commentId: said.value.id },
    });
  log.info("converge already done", {
    fork: `${fork.ownerName}/${fork.name}`,
    issue: issue.number,
    parentTip: relation.parentTip.slice(0, 7),
  });
  return true;
}

/** The oldest commit on the fork's default branch that has the parent's tip behind it. */
async function holdingCommit(
  app: App,
  fork: Repo,
  relation: ForkRelation,
): Promise<string> {
  if (!isSafeOid(relation.parentTip) || !isSafeOid(relation.forkTip))
    return relation.forkTip;
  const dir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const walked = await runGit(
    ["rev-list", "--ancestry-path", "--reverse", `${relation.parentTip}..${relation.forkTip}`],
    { cwd: dir },
  );
  const first = walked.ok ? walked.value.split("\n").find(Boolean) : undefined;
  return first ?? relation.forkTip;
}

/**
 * Settle every fork's converge issue: on a push or landed pull on the
 * fork's default branch, and (see `settleAll`) on the tick. Returns the
 * unsubscribe.
 */
export function settleOnPush(app: App): () => void {
  return app.bus.subscribe((event) => {
    if (event.repoId === null) return;
    if (event.kind !== "push" && event.kind !== "pull.merged") return;
    const fork = getRepoById(app.db, event.repoId);
    if (fork === undefined || fork.forkParentId === null) return;
    const parent = getRepoById(app.db, fork.forkParentId);
    if (parent === undefined) return;
    const by =
      event.actorId === null || event.actorId === undefined
        ? undefined
        : getUserById(app.db, event.actorId);
    settleConverge(app, fork, parent, by).catch((error) =>
      log.error("could not settle a converge issue", {
        fork: `${fork.ownerName}/${fork.name}`,
        error: String(error),
      }),
    );
  });
}

/** The tick's pass: every fork with a converge issue still open. */
export async function settleAll(app: App): Promise<number> {
  let closed = 0;
  for (const fork of listAllForks(app.db)) {
    const parent =
      fork.forkParentId === null ? undefined : getRepoById(app.db, fork.forkParentId);
    if (parent === undefined) continue;
    try {
      if (await settleConverge(app, fork, parent)) closed++;
    } catch (error) {
      log.error("could not settle a converge issue", {
        fork: `${fork.ownerName}/${fork.name}`,
        error: String(error),
      });
    }
  }
  return closed;
}
