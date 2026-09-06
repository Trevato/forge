/**
 * One agent run, end to end: claim it, mint a credential that dies with
 * it, put the agent in a clone on the right branch, tell it the task, let
 * Claude Code work, then do the bookkeeping the agent should never have to
 * get right — push what it committed, open or update the pull, report on
 * the issue — and record the outcome.
 *
 * The clone lives at `<data>/crew/<agent>/<repo id>/<issue n>/` for as long
 * as the pull is open, so a follow-up resumes the same session in the same
 * tree. The remote is truth: every run starts by resetting the branch to
 * what the forge has.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { openPull } from "../actions/pulls.ts";
import { announceRun } from "../actions/runs.ts";
import { previewEnv } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAgent, type Agent } from "../core/agents.ts";
import { getAppByRepo } from "../core/apps.ts";
import {
  getIssue,
  getIssueById,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { listReviewComments, listReviews } from "../core/reviews.ts";
import {
  checkSummary,
  claimRun,
  finishRun,
  lastAgentRun,
  noteRunProgress,
  type Run,
} from "../core/runs.ts";
import { createToken, deleteToken } from "../core/tokens.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { aheadCount, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { appendRunLog, readRunLog } from "../runs/log.ts";
import {
  branchFor,
  issueOfBranch,
  systemPrompt,
  taskPrompt,
  type RunReason,
} from "./brief.ts";
import { runClaude } from "./claude.ts";
import { trackAgentRun, untrackAgentRun } from "./running.ts";
import { sandboxPolicy } from "./sandbox.ts";
import { workdirFor } from "./workdir.ts";

const log = createLog("crew");

export interface CrewOptions {
  /** The forge's public URL — what the agent is told and links to. */
  readonly forgeUrl: string;
  /** Where the forge answers on this machine — what git clones from. */
  readonly localUrl: string;
  readonly binary: string;
  readonly concurrency: number;
  /** Spend per run when the agent's own budget is 0. */
  readonly budgetUsd: number;
  readonly runTimeoutMs: number;
  /** A `CLAUDE_CONFIG_DIR` for runs, when the operator wants one. */
  readonly configDir?: string | undefined;
  /** Hosts an agent's shell may reach beyond the forge and the registry. */
  readonly allowHosts?: readonly string[] | undefined;
}

export { crewRoot, workdirFor } from "./workdir.ts";

/** Claim and execute a queued agent run. Never throws. */
export async function executeAgentRun(
  app: App,
  run: Run,
  options: CrewOptions,
): Promise<void> {
  const claimed = claimRun(app.db, run.id);
  if (!claimed) return;
  const controller = new AbortController();
  trackAgentRun(run.id, controller);
  const write = (line: string): void =>
    appendRunLog(app.config.dataDir, run.id, line);
  announceRun(app, claimed);
  let outcome: Outcome;
  try {
    outcome = await work(app, claimed, options, write, controller.signal);
  } catch (error) {
    log.error("agent run threw", { run: run.id, error: String(error) });
    outcome = {
      state: "failed",
      summary: `the run failed: ${String(error).slice(0, 200)}`,
    };
  } finally {
    untrackAgentRun(run.id);
  }
  // Whatever the agent left running in its clone — a server it started to
  // try something — ends with the run. The sandbox refuses it `kill`, so the
  // forge does the tidying, by the directory the process is working in.
  await reapOrphans(app, run, write);
  write(
    outcome.state === "ok"
      ? `done: ${outcome.summary}`
      : `failed: ${outcome.summary}`,
  );
  const done = finishRun(app.db, run.id, {
    state: outcome.state,
    summary: outcome.summary,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
  });
  if (done) announceRun(app, done);
}

/**
 * Processes still holding files under the run's clone, after the run: the
 * agent's leftovers. `lsof +D` is the honest way to find them on macOS and
 * Linux alike; a machine without it keeps its leftovers and the log says so.
 */
async function reapOrphans(
  app: App,
  run: Run,
  write: (line: string) => void,
): Promise<void> {
  const repo = getRepoById(app.db, run.repoId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  if (!repo || !agent || !issue) return;
  const branch = run.branch;
  const number = issueOfBranch(agent, branch) ?? issue.number;
  const dir = workdirFor(app.config.dataDir, agent, repo, number);
  if (!existsSync(dir)) return;
  let out = "";
  try {
    const proc = Bun.spawn(["lsof", "-t", "+D", dir], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
  } catch {
    return; // no lsof here
  }
  const pids = [...new Set(out.split(/\s+/).filter((p) => /^\d+$/.test(p)))]
    .map(Number)
    .filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      write(`stopped a process the agent left running (pid ${pid})`);
    } catch {
      // Already gone.
    }
  }
}

interface Outcome {
  readonly state: "ok" | "failed";
  readonly summary: string;
  readonly sessionId?: string | undefined;
  readonly costUsd?: number | undefined;
}

async function work(
  app: App,
  run: Run,
  options: CrewOptions,
  write: (line: string) => void,
  signal: AbortSignal,
): Promise<Outcome> {
  const repo = getRepoById(app.db, run.repoId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  if (!repo || !issue || !agent)
    return {
      state: "failed",
      summary: "the repository, issue or agent no longer exists",
    };
  if (repo.origin !== null)
    return {
      state: "failed",
      summary: "agents do not work on mirrored repositories yet",
    };
  const reason = run.reason as RunReason;

  const pull =
    issue.kind === "pull" ? getPull(app.db, repo.id, issue.number) : undefined;
  if (pull?.crossRepo)
    return {
      state: "failed",
      summary: "this pull's branch lives in a fork the agent cannot push to",
    };
  const branch = pull?.headBranch ?? (run.branch || branchFor(agent, issue));
  if (!isSafeRef(branch))
    return { state: "failed", summary: `unsafe branch name ${branch}` };
  noteRunProgress(app.db, run.id, { branch });
  const taskNumber =
    pull === undefined
      ? issue.number
      : (issueOfBranch(agent, branch) ?? issue.number);
  const dir = workdirFor(app.config.dataDir, agent, repo, taskNumber);
  write(
    `${agent.user.username} on ${repo.ownerName}/${repo.name}#${issue.number} (${reason}), branch ${branch}`,
  );

  // The credential: rw, named for the run, gone when it ends.
  const expires = new Date(
    Date.now() + options.runTimeoutMs + 10 * 60_000,
  ).toISOString();
  const token = createToken(app.db, agent.user.id, `run:${run.id}`, "rw", {
    expiresAt: expires,
  });
  const gitAuth = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${agent.user.username}:${token.token}`).toString("base64")}`,
    // The operator's own credential helper (a keychain, usually) would try
    // to store the header's credential and fail loudly on every push. The
    // header is the credential; no helper applies.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
  const identity = {
    GIT_AUTHOR_NAME: agent.user.displayName || agent.user.username,
    GIT_AUTHOR_EMAIL: agent.user.email,
    GIT_COMMITTER_NAME: agent.user.displayName || agent.user.username,
    GIT_COMMITTER_EMAIL: agent.user.email,
  };

  try {
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const prepared = await prepareClone(
      app,
      options,
      repo,
      branch,
      dir,
      { ...gitAuth, ...identity },
      write,
      signal,
    );
    if (!prepared.ok) return { state: "failed", summary: prepared.error };

    // What the agent is told.
    // The session belongs to the task, which spans the issue and the pull
    // opened for it: a follow-up on the pull resumes the run on the issue.
    const taskIssue =
      pull === undefined ? undefined : getIssue(app.db, repo.id, taskNumber);
    const previous =
      lastAgentRun(app.db, issue.id, agent.user.id) ??
      (taskIssue === undefined
        ? undefined
        : lastAgentRun(app.db, taskIssue.id, agent.user.id));
    const since = previous?.finishedAt ?? issue.createdAt;
    const record = getAppByRepo(app.db, repo.id);
    const runtime = appsRuntime(app);
    const previewUrl =
      record && runtime && pull
        ? runtime.urlFor(record, previewEnv(pull.number))
        : undefined;
    const brief = {
      agent,
      repo,
      issue,
      pull,
      branch,
      forgeUrl: options.forgeUrl,
      isApp: record !== undefined,
      previewUrl,
      resuming: previous?.sessionId !== undefined && previous.sessionId !== "",
    };
    const failedCheck =
      reason === "check_failed" && pull
        ? checkSummary(
            app.db,
            pull.id,
            (await resolveOid(bare, `refs/heads/${branch}`)) ?? pull.headOid,
          )
        : undefined;
    const prompt = taskPrompt({
      ...brief,
      reason,
      comments: listComments(app.db, issue.id, { kind: "comment" }),
      reviews: pull ? listReviews(app.db, pull.id) : [],
      reviewComments: pull ? listReviewComments(app.db, pull.id) : [],
      since,
      checkSummary: failedCheck?.run?.summary,
      checkLog: failedCheck?.run
        ? readRunLog(
            app.config.dataDir,
            failedCheck.run.id,
            8 * 1024,
          ).lines.slice(-40)
        : undefined,
    });

    const env: Record<string, string> = {
      ...gitAuth,
      ...identity,
      FORGE_URL: options.forgeUrl,
      FORGE_TOKEN: token.token,
      ...(process.env["ANTHROPIC_API_KEY"] === undefined
        ? {}
        : { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }),
      ...(options.configDir === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: options.configDir }),
    };
    const budget = agent.budgetUsd > 0 ? agent.budgetUsd : options.budgetUsd;
    const sandbox = sandboxPolicy({
      dataDir: app.config.dataDir,
      agentName: agent.user.username,
      urls: [options.localUrl, options.forgeUrl],
      extraHosts: options.allowHosts,
    });
    const invoke = (resume: string | undefined) =>
      runClaude({
        binary: options.binary,
        cwd: dir,
        prompt,
        appendSystemPrompt: systemPrompt(brief),
        model: agent.model || undefined,
        budgetUsd: budget,
        resume,
        env,
        sandbox,
        timeoutMs: options.runTimeoutMs,
        log: write,
        signal,
      });
    write(
      `claude: budget $${budget.toFixed(2)}${brief.resuming ? `, resuming ${previous?.sessionId}` : ""}`,
    );
    let result = await invoke(brief.resuming ? previous?.sessionId : undefined);
    if (!result.ok && brief.resuming && result.turns === 0 && !signal.aborted) {
      write("the session could not be resumed; starting fresh");
      result = await invoke(undefined);
    }
    noteRunProgress(app.db, run.id, {
      sessionId: result.sessionId,
      costUsd: result.costUsd,
    });
    write(
      `claude: ${result.reason}, ${result.turns} turns, $${result.costUsd.toFixed(2)}`,
    );
    if (signal.aborted)
      return {
        state: "failed",
        summary: "cancelled",
        sessionId: result.sessionId,
        costUsd: result.costUsd,
      };

    // The decline contract: an agent that should not do the task says so
    // instead of guessing, and nothing it touched becomes a proposal.
    const declined = /^\s*DECLINED\b/i.test(result.result);
    if (declined) {
      const why = result.result.replace(/^\s*DECLINED:?\s*/i, "").trim();
      write(`declined: ${why.split("\n")[0] ?? ""}`);
      const target = pull ?? issue;
      addComment(
        app,
        agent.user,
        repo,
        target,
        `Declined: ${why || "no reason given"}`,
      );
      return {
        state: "failed",
        summary: `declined: ${(why.split("\n")[0] ?? "").slice(0, 200)}`,
        sessionId: result.sessionId,
        costUsd: result.costUsd,
      };
    }

    // Bookkeeping the agent does not have to get right.
    const landed = await landWork(
      app,
      options,
      repo,
      agent,
      issue,
      pull,
      branch,
      dir,
      bare,
      { ...gitAuth, ...identity },
      result.result,
      write,
    );
    return {
      state: result.ok || landed.pushed ? "ok" : "failed",
      summary: landed.summary + (result.ok ? "" : ` (${result.reason})`),
      sessionId: result.sessionId,
      costUsd: result.costUsd,
    };
  } finally {
    deleteToken(app.db, agent.user.id, token.id);
  }
}

/** A clone on `branch`, matching what the forge holds. */
async function prepareClone(
  app: App,
  options: CrewOptions,
  repo: Repo,
  branch: string,
  dir: string,
  env: Record<string, string>,
  write: (line: string) => void,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${options.localUrl}/${repo.ownerName}/${repo.name}.git`;
  if (signal.aborted) return { ok: false, error: "cancelled" };
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    write(`cloning ${repo.ownerName}/${repo.name}`);
    const cloned = await runGit(["clone", "--quiet", "--", url, dir], {
      env,
      timeoutMs: 5 * 60_000,
    });
    if (!cloned.ok)
      return {
        ok: false,
        error: `clone failed: ${cloned.error.stderr.slice(0, 200)}`,
      };
  } else {
    const fetched = await runGit(["fetch", "--quiet", "--prune", "origin"], {
      cwd: dir,
      env,
      timeoutMs: 2 * 60_000,
    });
    if (!fetched.ok)
      return {
        ok: false,
        error: `fetch failed: ${fetched.error.stderr.slice(0, 200)}`,
      };
  }
  const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const remote = await resolveOid(bare, `refs/heads/${branch}`);
  const start =
    remote === undefined ? `origin/${repo.defaultBranch}` : `origin/${branch}`;
  // A leftover from a cut-off run is discarded: the remote is truth.
  await runGit(["reset", "--quiet", "--hard"], { cwd: dir, env });
  await runGit(["clean", "-fdq"], { cwd: dir, env });
  const checked = await runGit(["checkout", "--quiet", "-B", branch, start], {
    cwd: dir,
    env,
  });
  if (!checked.ok)
    return {
      ok: false,
      error: `checkout failed: ${checked.error.stderr.slice(0, 200)}`,
    };
  // The branch tracks its remote from the start, set here where git config
  // is writable: inside the sandbox `.git/config` is not, so a plain
  // `git push` must already know where to go.
  await runGit(["config", `branch.${branch}.remote`, "origin"], {
    cwd: dir,
    env,
  });
  await runGit(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], {
    cwd: dir,
    env,
  });
  write(
    remote === undefined
      ? `branch ${branch} from ${repo.defaultBranch}`
      : `branch ${branch} at ${remote.slice(0, 7)}`,
  );
  return { ok: true };
}

/**
 * After the agent stops: push what it committed if it did not, open the
 * pull if there is none, and report on the conversation.
 */
async function landWork(
  app: App,
  options: CrewOptions,
  repo: Repo,
  agent: Agent,
  issue: Issue,
  pull: Pull | undefined,
  branch: string,
  dir: string,
  bare: string,
  env: Record<string, string>,
  message: string,
  write: (line: string) => void,
): Promise<{ pushed: boolean; summary: string }> {
  // Work left in the tree is committed on the agent's behalf: a proposal a
  // person can read beats an edit nobody sees. The summary says it happened.
  const status = await runGit(["status", "--porcelain"], { cwd: dir, env });
  let committedForIt = false;
  if (status.ok && status.value.trim() !== "") {
    const subject =
      message
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.trim() ?? issue.title;
    await runGit(["add", "-A"], { cwd: dir, env });
    const commit = await runGit(
      [
        "commit",
        "--quiet",
        "-m",
        subject.slice(0, 200),
        "-m",
        `Work by @${agent.user.username} on #${issue.number}, committed by the forge.`,
      ],
      { cwd: dir, env },
    );
    committedForIt = commit.ok;
    write(
      commit.ok
        ? "committed the agent's uncommitted changes"
        : `could not commit leftover changes: ${commit.error.stderr.slice(0, 200)}`,
    );
  }
  const head = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: dir,
    env,
  });
  const local = head.ok ? head.value.trim() : undefined;
  let remote = await resolveOid(bare, `refs/heads/${branch}`);
  const base = await resolveOid(bare, `refs/heads/${repo.defaultBranch}`);
  if (local !== undefined && local !== remote) {
    // Ahead of what the forge holds: the branch if it exists there, the
    // default branch otherwise — a fresh branch at the base tip is nothing.
    const against = remote ?? base;
    const ahead =
      against === undefined ? 1 : await aheadCount(dir, against, local);
    if (ahead > 0) {
      write(
        `pushing ${branch} (${ahead} commit${ahead === 1 ? "" : "s"} the agent did not push)`,
      );
      const pushed = await runGit(
        ["push", "--quiet", "-u", "origin", `${branch}:${branch}`],
        { cwd: dir, env, timeoutMs: 2 * 60_000 },
      );
      if (!pushed.ok)
        write(`push refused: ${pushed.error.stderr.slice(0, 300)}`);
      remote = await resolveOid(bare, `refs/heads/${branch}`);
    }
  }
  const proposed =
    remote !== undefined && base !== undefined
      ? await aheadCount(bare, base, remote)
      : 0;
  const report = message.trim();

  if (proposed === 0) {
    write(
      "nothing to propose: the branch has no commits beyond the default branch",
    );
    if (report !== "" && pull === undefined)
      addComment(app, agent.user, repo, issue, report);
    else if (report !== "" && pull !== undefined)
      addComment(app, agent.user, repo, pull, report);
    const first = report.split("\n").find((l) => l.trim() !== "") ?? "";
    return {
      pushed: false,
      summary:
        first === ""
          ? "no changes pushed"
          : `no changes pushed: ${first.slice(0, 200)}`,
    };
  }

  const existing =
    pull ??
    listPulls(app.db, repo.id, { state: "open", limit: 200 }).find(
      (p) => !p.crossRepo && p.headBranch === branch,
    );
  if (existing !== undefined) {
    if (report !== "") addComment(app, agent.user, repo, existing, report);
    return {
      pushed: true,
      summary: `updated pull #${existing.number} (${remote?.slice(0, 7)})${committedForIt ? ", committing its leftover changes" : ""}`,
    };
  }
  const body = `${report === "" ? "" : `${report}\n\n`}Closes #${issue.number}`;
  const opened = await openPull(app, agent.user, repo, {
    title: issue.title,
    body,
    baseBranch: repo.defaultBranch,
    headBranch: branch,
  });
  if (!opened.ok) {
    write(`could not open the pull: ${JSON.stringify(opened.error)}`);
    return {
      pushed: true,
      summary: `pushed ${branch} but could not open a pull (${String(opened.error)})`,
    };
  }
  write(`opened pull #${opened.value.number}`);
  return {
    pushed: true,
    summary: `opened pull #${opened.value.number}${committedForIt ? ", committing its leftover changes" : ""}`,
  };
}
