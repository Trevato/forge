/**
 * Run actions: look at a repository's runs and their logs, cancel one,
 * queue a finished agent run's task again, and — for the workers that produce runs — announce a run's state on the
 * outbox. Reading follows the repository's visibility (a run's log is as
 * private as the code it ran), and a private app's runs follow the app: a
 * deploy log carries the app's own output, so only someone who may enter
 * the app reads them (#620). Cancelling takes write access; announcing is
 * the system's own voice and takes no actor.
 */

import { commitVerdicts, isCommitId, releaseCheck, type CommitCheck } from "../checks/commit_check.ts";
import { readLooks } from "../checks/looks.ts";
import { vitalsRows, type PageSize } from "../checks/summary.ts";
import { hasCommit, isAncestor } from "../git/local.ts";
import { repoDir } from "../git/repos.ts";
import { mayViewId } from "../core/sealed.ts";
import { requireVerified } from "./verify.ts";
import { requireAbility } from "./roles.ts";
import type { App } from "../app.ts";
import { steerRun } from "../crew/runner.ts";
import { getIssueById, getIssuesByIds } from "../core/issues.ts";
import { addComment } from "./issues.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canEnterApp, canSeeOwnerFacts, onCrew, type Repo } from "../core/repos.ts";
import {
  cancelRun as markCancelled,
  getRun,
  listRuns as queryRuns,
  runsMarker,
  type ListRunsOptions,
  type Run,
  setRunErrorLine,
} from "../core/runs.ts";
import { getUsersByIds, type User } from "../core/users.ts";
import { abortAgentRun } from "../crew/running.ts";
import { stopRun } from "../runs/stoppable.ts";
import { queueAgentRun, taskOf } from "../crew/dispatch.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readRunLog, readRunLogTail, runLogPath } from "../runs/log.ts";
import { shownStates, type ShownState } from "../runs/state.ts";
import { firstErrorLine } from "../runs/error_line.ts";
import { requireReader, requireWriter, type AccessError } from "./access.ts";

/** What a run event carries: enough for a surface to render the card. */
export function runPayload(run: Run): Record<string, unknown> {
  return {
    runId: run.id,
    kind: run.kind,
    state: run.state,
    env: run.env,
    commitOid: run.commitOid,
    reason: run.reason,
    summary: run.summary,
    costUsd: run.costUsd,
    turns: run.turns,
    ...(run.placement === "job" ? { placement: run.placement, node: run.node } : {}),
    ...(run.issueId === null ? {} : { issueId: run.issueId }),
  };
}

/**
 * Put a run's current state on the outbox: `run.queued`, `run.started` or
 * `run.finished` by its state. The one place a worker speaks.
 */
export function announceRun(app: App, run: Run, actorId?: string): void {
  const kind =
    run.state === "queued"
      ? "run.queued"
      : run.state === "running"
        ? "run.started"
        : "run.finished";
  app.bus.append({
    kind,
    repoId: run.repoId,
    ...(actorId === undefined ? {} : { actorId }),
    payload: { ...runPayload(run), ...(kind === "run.finished" ? failureOf(app, run) : {}) },
  });
}

/**
 * What a failed run's public event may say of it: the number of the pull or
 * issue it was for. The first error line of its log is a log line, so it is
 * kept with the run (`setRunErrorLine`), once, and never put on the event.
 */
function failureOf(app: App, run: Run): Record<string, unknown> {
  if (run.state !== "failed") return {};
  const found = firstErrorLine(readRunLog(app.config.dataDir, run.id).lines);
  if (found !== undefined) setRunErrorLine(app.db, run.id, found.text, found.at);
  const subject = run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  return subject === undefined ? {} : { subject: subject.number };
}

/**
 * Whether `actor` may read this repository's runs: anyone who can read it,
 * unless it runs a private app — then only someone who may enter the app.
 */
export function mayReadRuns(
  app: App,
  actor: User | undefined,
  repo: Repo,
): boolean {
  if (!requireReader(app, actor, repo).ok) return false;
  const record = getAppByRepo(app.db, repo.id);
  return (
    record === undefined ||
    canEnterApp(app.db, repo, record, actor, { named: false })
  );
}

/**
 * Whether `actor` may read a run's log — the agent's transcript, or a
 * deploy's output. A summary is public with the run; the log is for the
 * repository's writers and crew only, on a public repository too: it says
 * what the agent ran, read and concluded, in the detail it wrote for itself.
 */
export function mayReadRunLog(
  app: App,
  actor: User | undefined,
  repo: Repo,
): boolean {
  return (
    mayReadRuns(app, actor, repo) &&
    (canSeeOwnerFacts(app.db, repo, actor) || onCrew(app.db, repo, actor))
  );
}

/**
 * Whether `actor` may read this run's log: the run is theirs to see (app
 * gate, sealed report) and the log is theirs to read. The one question both
 * the log door and the live `run.log` frames ask.
 */
export function mayReadLogOfRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): boolean {
  return (
    getRepoRun(app, actor, repo, runId).ok && mayReadRunLog(app, actor, repo)
  );
}

/**
 * A run as this actor may read it. Its cost and turns are the owner's own
 * facts (`canSeeOwnerFacts`), and so is the machinery under it: the agent
 * session a follow-up resumes and the node it ran on (#2917). A reader who
 * cannot write here gets what ran, why and how it ended, never those — on
 * every door, since every door reads runs through here.
 */
export function runForReader(
  app: App,
  actor: User | undefined,
  repo: Repo,
): (run: Run) => Run {
  return canSeeOwnerFacts(app.db, repo, actor)
    ? (run) => run
    : (run) => ({ ...run, costUsd: 0, turns: 0, sessionId: "", node: "" });
}

export function listRepoRuns(
  app: App,
  actor: User | undefined,
  repo: Repo,
  options: ListRunsOptions = {},
): Result<Run[], "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  if (!mayReadRuns(app, actor, repo)) return ok([]);
  // A run on a sealed report, or its fix, is the report's (`core/sealed.ts`).
  return ok(
    queryRuns(app.db, repo.id, options)
      .filter((r) => mayViewId(app.db, repo, r.issueId, actor))
      .map(runForReader(app, actor, repo)),
  );
}

/**
 * What the runs list shows this reader, before the list is built: whether
 * they see cost and turns. Call it only for someone who may read runs. The
 * owner and a stranger never share it.
 */
export function runsViewKey(app: App, actor: User | undefined, repo: Repo, options: ListRunsOptions): string {
  const facts = canSeeOwnerFacts(app.db, repo, actor);
  return `${facts ? "f" : "-"}\n${runsMarker(app.db, repo.id, options)}`;
}

/** A run as the runs API lists it: the agent's name, and the pull or issue it is about. */
export type NamedRun = Run & {
  /** The state to show, worked out from what the run did (`runs/state.ts`). */
  readonly shown: ShownState;
  readonly agent: string | null;
  readonly number: number | null;
  readonly title: string | null;
};

/**
 * Names runs already read for this reader (`listRepoRuns`) in two grouped
 * reads: `agent` is the username behind an agent run (null for a check or
 * deploy), `number` and `title` the pull or issue the run is about (null when
 * it is about none). A sealed issue never reaches here: `listRepoRuns` drops
 * its runs for a reader who may not see it.
 */
export function nameRuns(app: App, runs: readonly Run[]): NamedRun[] {
  const actors = getUsersByIds(
    app.db,
    runs.flatMap((r) => (r.kind === "agent" && r.actorId !== null ? [r.actorId] : [])),
  );
  const issues = getIssuesByIds(
    app.db,
    runs.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const shown = shownStates(app.db, runs);
  return runs.map((r) => {
    const issue = r.issueId === null ? undefined : issues.get(r.issueId);
    return {
      ...r,
      shown: shown.get(r.id) ?? "waiting",
      agent: r.kind === "agent" && r.actorId !== null ? (actors.get(r.actorId)?.username ?? null) : null,
      number: issue?.number ?? null,
      title: issue?.title ?? null,
    };
  });
}

/**
 * The default branch's check that covers one commit (`checks/commit_check.ts`
 * `releaseCheck`), for whoever may read the repository's runs: what a
 * release waits on — the commit's own check, or a later main commit's that
 * contains it when main moved on before the commit's own check ran (#3966).
 */
export async function checkOfCommit(
  app: App,
  actor: User | undefined,
  repo: Repo,
  oid: string,
): Promise<Result<CommitCheck, "not_found">> {
  if (!isCommitId(oid) || !mayReadRuns(app, actor, repo)) return err("not_found");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  return ok(
    await releaseCheck(app.db, repo.id, repo.defaultBranch, oid, {
      has: () => hasCommit(dir, oid),
      contains: (descendant) => isAncestor(dir, oid, descendant),
    }),
  );
}

/** One look of a check as the API words it: how many screens tall, and whether a phone look scrolls sideways. */
export interface LookFigures {
  readonly look: string;
  readonly screens: string;
  readonly sideways: boolean;
  /** The window and page as measured (`scrollWidth` vs `innerWidth` says whether it fits); absent when none was recorded. */
  readonly size?: PageSize;
}

/**
 * The looks of the run that checked a commit, from the same file the run page
 * reads; `[]` for someone who may not read runs or when none were filed.
 */
export function looksOfCheck(
  app: App,
  actor: User | undefined,
  repo: Repo,
  run: { readonly id: string; readonly commitOid: string },
): LookFigures[] {
  if (!mayReadRuns(app, actor, repo)) return [];
  const looks = readLooks(app.config.dataDir, { id: run.id, repoId: repo.id, commitOid: run.commitOid });
  return vitalsRows(looks).map((g) => ({
    look: g.look,
    screens: g.screens,
    sideways: g.sideways,
    ...(g.size === undefined ? {} : { size: g.size }),
  }));
}

/** The own green or red verdicts of a page of commits, for whoever may read the runs; empty otherwise. */
export function verdictsOfCommits(
  app: App,
  actor: User | undefined,
  repo: Repo,
  oids: readonly string[],
): Map<string, CommitCheck> {
  if (!mayReadRuns(app, actor, repo)) return new Map();
  return commitVerdicts(app.db, repo.id, repo.defaultBranch, oids);
}

/** A run by id, only if it belongs to a repository the actor can see. */
export function getRepoRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): Result<Run, "not_found"> {
  if (!mayReadRuns(app, actor, repo)) return err("not_found");
  const run = getRun(app.db, runId);
  if (!run || run.repoId !== repo.id) return err("not_found");
  if (!mayViewId(app.db, repo, run.issueId, actor)) return err("not_found");
  return ok(runForReader(app, actor, repo)(run));
}

export interface RunLogView {
  readonly run: Run;
  readonly lines: string[];
  readonly truncated: boolean;
  readonly path: string;
  /** The reader may see the run but not its log: `lines` is empty. */
  readonly logHidden: boolean;
}

export function runLog(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
  tail?: number,
): Result<RunLogView, "not_found"> {
  const found = getRepoRun(app, actor, repo, runId);
  if (!found.ok) return found;
  const logHidden = !mayReadRunLog(app, actor, repo);
  const { lines, truncated } = logHidden
    ? { lines: [], truncated: false }
    : tail === undefined
      ? readRunLog(app.config.dataDir, runId)
      : readRunLogTail(app.config.dataDir, runId, tail);
  return ok({
    run: found.value,
    lines,
    truncated,
    path: runLogPath(app.config.dataDir, runId),
    logHidden,
  });
}

/**
 * Cancel a run that has not finished. A queued run never starts; a running
 * agent run or check worked here is stopped, every process it started with
 * it (#10776); a running deploy is abandoned by its environment when its
 * step ends.
 */
export function cancelRepoRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): Result<Run, AccessError | "finished"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const run = getRun(app.db, runId);
  if (!run || run.repoId !== repo.id) return err("not_found");
  const cancelled = markCancelled(
    app.db,
    runId,
    `cancelled by ${writer.value.username}`,
  );
  if (!cancelled) return err("finished");
  // The row says cancelled first, so the run's own end leaves it so; the
  // abort then ends the process group it started.
  if (run.kind === "agent") abortAgentRun(runId);
  else stopRun(runId);
  announceRun(app, cancelled, writer.value.id);
  return ok(cancelled);
}

/**
 * Queue a cancelled or failed agent run's task again: the same agent, the
 * same issue, the same reason. The run that starts reads the whole
 * conversation, so it carries on rather than starting over. Refused when
 * the issue is closed or the agent is gone (`no_task`), and when the crew
 * would not take it now — a run already waiting, the breaker tripped, the
 * day's ceiling reached (`not_queued`).
 */
export function requeueRepoRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): Result<Run, AccessError | "not_agent" | "not_finished" | "no_task" | "not_queued" | "not_member" | "archived"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  // A run costs money; like assigning, queueing one is a person's call.
  if (writer.value.kind === "agent") return err("forbidden");
  const run = getRun(app.db, runId);
  if (!run || run.repoId !== repo.id) return err("not_found");
  if (run.kind !== "agent") return err("not_agent");
  if (repo.archivedAt !== null) return err("archived");
  const member = requireAbility(app, writer.value, "run_crew");
  if (!member.ok) return member;
  if (run.state !== "cancelled" && run.state !== "failed")
    return err("not_finished");
  const task = taskOf(app, run);
  if (task === undefined) return err("no_task");
  const queued = queueAgentRun(
    app,
    task.repo,
    task.issue,
    task.agent,
    task.reason,
    writer.value.id,
  );
  return queued ? ok(queued) : err("not_queued");
}

export type SteerOutcome =
  /** The agent hears it at its next step. */
  | "sent"
  /** No session was listening; it went on the conversation for the next run. */
  | "commented";

/** What each outcome means, said the same on every surface that steers. */
export const STEER_SAYS: Record<SteerOutcome, string> = {
  sent: "The agent hears it at its next step.",
  commented:
    "No session was listening; it went on the conversation for the next run.",
};

/**
 * Say something to an agent mid-run. A running agent hears it as its next
 * user turn. A run that is queued, paused, or over has nobody listening,
 * so the words go on the issue or pull instead, where the next run reads
 * them — a feedback run, like any comment from a person.
 */
export function steerRepoRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
  text: string,
): Result<SteerOutcome, AccessError | "empty" | "not_agent" | "unverified"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const proven = requireVerified(app, writer.value);
  if (!proven.ok) return proven;
  // A run costs money; like assigning, queueing one is a person's call.
  if (writer.value.kind === "agent") return err("forbidden");
  const run = getRun(app.db, runId);
  if (!run || run.repoId !== repo.id) return err("not_found");
  if (run.kind !== "agent") return err("not_agent");
  const said = text.trim();
  if (said === "") return err("empty");
  if (run.state === "running" && steerRun(app, run.id, said)) return ok("sent");
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  if (issue === undefined) return err("not_found");
  const commented = addComment(app, writer.value, repo, issue, said);
  if (!commented.ok) return err("forbidden");
  return ok("commented");
}
