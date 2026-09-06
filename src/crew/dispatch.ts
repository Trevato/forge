/**
 * How work reaches the crew. The dispatcher listens to the outbox and
 * sweeps behind it: an issue assigned to an agent becomes a run; a person
 * speaking on an agent's pull — a comment, a verdict, a line comment —
 * becomes a follow-up; a failed deploy of an agent's pull becomes a
 * bounded follow-up. Runs are rows first (`queued`), and a worker tick
 * takes them in order up to the concurrency limit, one per issue at a
 * time. A missed wake-up costs a tick, never a run.
 */

import { rmSync } from "node:fs";
import type { App } from "../app.ts";
import { announceRun } from "../actions/runs.ts";
import { getAgent, type Agent } from "../core/agents.ts";
import type { ForgeEvent } from "../core/events.ts";
import {
  getIssue,
  getIssueById,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { listReviews } from "../core/reviews.ts";
import {
  activeRunFor,
  automaticRunsSince,
  createRun,
  getRun,
  listActive,
  listQueued,
  type Run,
} from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { issueOfBranch, type RunReason } from "./brief.ts";
import { detectClaude } from "./claude.ts";
import { executeAgentRun, workdirFor, type CrewOptions } from "./runner.ts";
import { abortAgentRun } from "./running.ts";

const log = createLog("crew");

/** Automatic follow-ups after a failed check, before a person must speak. */
const CHECK_FAILED_LIMIT = 2;
const TICK_MS = 5_000;

export interface CrewHandle {
  /** Whether a usable Claude Code was found at start. */
  readonly ready: boolean;
  readonly detail: string;
  stop(): Promise<void>;
}

const handles = new WeakMap<App, CrewHandle>();

/** The crew serving this forge, if one was started. */
export const crewFor = (app: App): CrewHandle | undefined => handles.get(app);

export async function startCrew(
  app: App,
  options: CrewOptions,
): Promise<CrewHandle> {
  const detected = await detectClaude(options.binary);
  if (!detected.ok)
    log.warn("claude not usable; agent runs will fail", {
      error: detected.error,
    });
  else
    log.info("crew is up", {
      claude: detected.version,
      concurrency: options.concurrency,
    });

  let stopped = false;
  // Runs `pump` has started and not yet seen finish. `stop()` aborts each
  // and waits for it: without this, a run `pump` fired (fire-and-forget)
  // keeps cloning, spawning and eventually calling `finishRun`/`announceRun`
  // on `app.db` after a caller who awaited `stop()` believed the crew was
  // quiet and closed it.
  const inFlight = new Map<string, Promise<void>>();
  const unsubscribe = app.bus.subscribe((event) => {
    try {
      route(app, event);
    } catch (error) {
      log.error("crew routing failed", {
        kind: event.kind,
        error: String(error),
      });
    }
  });
  const timer = setInterval(() => {
    if (!stopped) pump(app, options, inFlight);
  }, TICK_MS);
  sweep(app);
  pump(app, options, inFlight);

  const handle: CrewHandle = {
    ready: detected.ok,
    detail: detected.ok ? `Claude Code ${detected.version}` : detected.error,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      for (const runId of inFlight.keys()) abortAgentRun(runId);
      await Promise.all(inFlight.values());
      handles.delete(app);
    },
  };
  handles.set(app, handle);
  return handle;
}

/** Queue a run about an issue for an agent, unless one is already waiting. */
export function queueAgentRun(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  reason: RunReason,
  actorId?: string,
): Run | undefined {
  const active = activeRunFor(app.db, "agent", issue.id);
  // One queued follow-up is enough: the run that eventually starts reads
  // the whole conversation since the last one, so nothing is lost.
  if (
    active !== undefined &&
    (active.state === "queued" || reason === "assigned")
  )
    return undefined;
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.id,
    actorId: agent.user.id,
    reason,
  });
  announceRun(app, run, actorId);
  return run;
}

function route(app: App, event: ForgeEvent): void {
  if (event.repoId === null) return;
  const number = event.payload["number"];
  const repo = getRepoById(app.db, event.repoId);
  if (!repo) return;

  switch (event.kind) {
    case "issue.assigned":
    case "pull.assigned": {
      if (event.payload["agent"] !== true || typeof number !== "number") return;
      const issue = getIssue(app.db, repo.id, number);
      const agent = issue?.assigneeId
        ? getAgent(app.db, issue.assigneeId)
        : undefined;
      if (!issue || !agent || issue.state !== "open") return;
      queueAgentRun(
        app,
        repo,
        issue,
        agent,
        "assigned",
        event.actorId ?? undefined,
      );
      return;
    }
    case "issue.commented":
    case "pull.commented":
    case "pull.reviewed": {
      if (typeof number !== "number") return;
      if (event.payload["via"] === "origin") return;
      const actor =
        event.actorId === null ? undefined : getUserById(app.db, event.actorId);
      if (!actor || actor.kind === "agent") return; // agents talking is not feedback
      if (
        event.kind === "pull.reviewed" &&
        event.payload["state"] === "approved"
      )
        return;
      const issue = getIssue(app.db, repo.id, number);
      if (!issue || issue.state !== "open") return;
      const agent = agentFor(app, issue);
      if (!agent) return;
      queueAgentRun(app, repo, issue, agent, "feedback", actor.id);
      return;
    }
    case "run.finished": {
      if (
        event.payload["kind"] !== "deploy" ||
        event.payload["state"] !== "failed"
      )
        return;
      const issueId = event.payload["issueId"];
      if (typeof issueId !== "string") return;
      const issue = getIssueById(app.db, issueId);
      if (!issue || issue.kind !== "pull" || issue.state !== "open") return;
      const agent = agentFor(app, issue);
      if (!agent) return;
      // Bounded: after a few failed checks in a row the agent stops and a
      // person must speak (docs/APPS.md, rule 7).
      const since = lastHumanWord(app, issue, agent);
      if (automaticRunsSince(app.db, issue.id, since) >= CHECK_FAILED_LIMIT) {
        log.info("check failed again; waiting for a person", {
          issue: issue.number,
        });
        return;
      }
      queueAgentRun(app, repo, issue, agent, "check_failed");
      return;
    }
    case "pull.closed":
    case "pull.merged": {
      if (typeof number !== "number") return;
      const pull = getPull(app.db, repo.id, number);
      if (!pull) return;
      forgetWorkdir(app, repo, pull);
      return;
    }
    default:
      return;
  }
}

/** The agent an issue or pull belongs to: the assignee, or the pull's author. */
function agentFor(app: App, issue: Issue): Agent | undefined {
  if (issue.assigneeId !== null) {
    const assigned = getAgent(app.db, issue.assigneeId);
    if (assigned) return assigned;
  }
  return issue.kind === "pull" ? getAgent(app.db, issue.authorId) : undefined;
}

/** When a person last said anything on the conversation, or its start. */
function lastHumanWord(app: App, issue: Issue, agent: Agent): string {
  let latest = issue.createdAt;
  for (const c of listComments(app.db, issue.id)) {
    if (c.authorName !== agent.user.username && c.createdAt > latest)
      latest = c.createdAt;
  }
  for (const r of listReviews(app.db, issue.id)) {
    if (r.authorName !== agent.user.username && r.createdAt > latest)
      latest = r.createdAt;
  }
  return latest;
}

function forgetWorkdir(app: App, repo: Repo, pull: Pull): void {
  const agent = agentFor(app, pull);
  if (!agent) return;
  const number = issueOfBranch(agent, pull.headBranch) ?? pull.number;
  rmSync(workdirFor(app.config.dataDir, agent, repo, number), {
    recursive: true,
    force: true,
  });
}

/**
 * The sweep behind the wake-up: an open issue assigned to an agent that
 * has never had a run (assigned while the crew was off) gets one now.
 */
function sweep(app: App): void {
  const rows = app.db
    .query<{ id: string; repo_id: string }, []>(
      `SELECT issue.id, issue.repo_id FROM issue
       JOIN user ON user.id = issue.assignee_id AND user.is_agent = 1
       WHERE issue.state = 'open'
         -- A pull an agent opened starts assigned to it; that is its own
         -- work landing, not a task waiting for a run.
         AND NOT (issue.kind = 'pull' AND issue.author_id = issue.assignee_id)
         AND NOT EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id AND run.kind = 'agent')
       ORDER BY issue.id LIMIT 100`,
    )
    .all();
  for (const row of rows) {
    const issue = getIssueById(app.db, row.id);
    const repo = getRepoById(app.db, row.repo_id);
    const agent = issue?.assigneeId
      ? getAgent(app.db, issue.assigneeId)
      : undefined;
    if (issue && repo && agent)
      queueAgentRun(app, repo, issue, agent, "assigned");
  }
}

/** Take queued runs, oldest first, up to the limit — one per issue at a time. */
function pump(
  app: App,
  options: CrewOptions,
  inFlight: Map<string, Promise<void>>,
): void {
  const active = listActive(app.db, "agent");
  const runningIssues = new Set(
    active.filter((r) => r.state === "running").map((r) => r.issueId),
  );
  let slots = options.concurrency - runningIssues.size;
  for (const queued of listQueued(app.db, "agent", 50)) {
    if (slots <= 0) break;
    if (queued.issueId !== null && runningIssues.has(queued.issueId)) continue;
    const fresh = getRun(app.db, queued.id);
    if (!fresh || fresh.state !== "queued") continue;
    slots--;
    if (queued.issueId !== null) runningIssues.add(queued.issueId);
    const running = executeAgentRun(app, fresh, options)
      .catch((error) =>
        log.error("agent run failed to execute", {
          run: queued.id,
          error: String(error),
        }),
      )
      .finally(() => inFlight.delete(queued.id));
    inFlight.set(queued.id, running);
  }
}
