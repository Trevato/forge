/**
 * Run actions: look at a repository's runs and their logs, cancel one,
 * queue a finished agent run's task again, and — for the workers that produce runs — announce a run's state on the
 * outbox. Reading follows the repository's visibility (a run's log is as
 * private as the code it ran), and a private app's runs follow the app: a
 * deploy log carries the app's own output, so only someone who may enter
 * the app reads them (#620). Cancelling takes write access; announcing is
 * the system's own voice and takes no actor.
 */

import { requireVerified } from "./verify.ts";
import type { App } from "../app.ts";
import { steerRun } from "../crew/runner.ts";
import { getIssueById } from "../core/issues.ts";
import { addComment } from "./issues.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canEnterApp, type Repo } from "../core/repos.ts";
import {
  cancelRun as markCancelled,
  getRun,
  listRuns as queryRuns,
  type ListRunsOptions,
  type Run,
} from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { abortAgentRun } from "../crew/running.ts";
import { queueAgentRun, taskOf } from "../crew/dispatch.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readRunLog, runLogPath } from "../runs/log.ts";
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
    payload: runPayload(run),
  });
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

export function listRepoRuns(
  app: App,
  actor: User | undefined,
  repo: Repo,
  options: ListRunsOptions = {},
): Result<Run[], "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  if (!mayReadRuns(app, actor, repo)) return ok([]);
  return ok(queryRuns(app.db, repo.id, options));
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
  return ok(run);
}

export interface RunLogView {
  readonly run: Run;
  readonly lines: string[];
  readonly truncated: boolean;
  readonly path: string;
}

export function runLog(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): Result<RunLogView, "not_found"> {
  const found = getRepoRun(app, actor, repo, runId);
  if (!found.ok) return found;
  const { lines, truncated } = readRunLog(app.config.dataDir, runId);
  return ok({
    run: found.value,
    lines,
    truncated,
    path: runLogPath(app.config.dataDir, runId),
  });
}

/**
 * Cancel a run that has not finished. A queued run never starts; a running
 * agent run is stopped; a running deploy is abandoned by its environment
 * when its step ends.
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
  if (run.kind === "agent") abortAgentRun(runId);
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
): Result<Run, AccessError | "not_agent" | "not_finished" | "no_task" | "not_queued"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  // A run costs money; like assigning, queueing one is a person's call.
  if (writer.value.kind === "agent") return err("forbidden");
  const run = getRun(app.db, runId);
  if (!run || run.repoId !== repo.id) return err("not_found");
  if (run.kind !== "agent") return err("not_agent");
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
