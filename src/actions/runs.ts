/**
 * Run actions: look at a repository's runs and their logs, cancel one, and
 * — for the workers that produce runs — announce a run's state on the
 * outbox. Reading follows the repository's visibility (a run's log is as
 * private as the code it ran); cancelling takes write access; announcing
 * is the system's own voice and takes no actor.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import {
  cancelRun as markCancelled,
  getRun,
  listRuns as queryRuns,
  type ListRunsOptions,
  type Run,
} from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { abortAgentRun } from "../crew/running.ts";
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

export function listRepoRuns(
  app: App,
  actor: User | undefined,
  repo: Repo,
  options: ListRunsOptions = {},
): Result<Run[], "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  return ok(queryRuns(app.db, repo.id, options));
}

/** A run by id, only if it belongs to a repository the actor can see. */
export function getRepoRun(
  app: App,
  actor: User | undefined,
  repo: Repo,
  runId: string,
): Result<Run, "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
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
