/**
 * The pull that opens at the agent's first push, not at the run's end.
 *
 * While the agent works, its branch in the fork is looked at once a second
 * for the first few seconds, then every few; each look costs git processes.
 * The first time it is a commit beyond the base, the pull opens with the
 * title, base and head `landWork` would use, and a body that says the work
 * is in progress and where the run's log is. Every later push reaches the
 * pull's preview as any push does. At the end `landWork` finds this pull by
 * its head and fills it in (`fillPull`); it never opens a second.
 */

import { openPull } from "../actions/pulls.ts";
import { editIssue, addComment, setIssueState } from "../actions/issues.ts";
import type { App } from "../app.ts";
import type { Agent } from "../core/agents.ts";
import type { Issue } from "../core/issues.ts";
import { listComments } from "../core/issues.ts";
import { listPulls, type Pull } from "../core/pulls.ts";
import { listReviews } from "../core/reviews.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import type { Run } from "../core/runs.ts";
import { aheadCount, contentOnBase, resolveOid } from "../git/merge.ts";

/** How often the branch is looked at at first. */
export const WATCH_MS = 1000;

/** Looks at the quick rate before the watcher slows to `SLOW_FACTOR` times it. */
export const QUICK_LOOKS = 5;
export const SLOW_FACTOR = 5;

/** The body's first words while the run is still going. */
export const IN_PROGRESS = "In progress:";

/** The body's first words once the run has ended without reporting on it. */
export const ENDED = "The run ended before it reported on this work.";

/** The line that links the pull to the issue (or pull) it answers. */
export function trailerFor(issue: Issue): string {
  return issue.kind === "pull"
    ? `Continues #${issue.number}`
    : `Closes #${issue.number}`;
}

/** The open pull whose head is this branch of this fork, if any. */
export function pullOfBranch(
  app: App,
  repo: Repo,
  fork: Repo,
  branch: string,
): Pull | undefined {
  return listPulls(app.db, repo.id, {
    sealed: true,
    state: "open",
    limit: 200,
  }).find((p) => p.headRepoId === fork.id && p.headBranch === branch);
}

export interface EarlyInput {
  app: App;
  repo: Repo;
  agent: Agent;
  issue: Issue;
  run: Run;
  fork: Repo;
  branch: string;
  forkBare: string;
  bare: string;
  forgeUrl: string;
  write: (line: string) => void;
  variantGroup: string | null;
  /** A pull already stands for this work: nothing to open. */
  continuing: boolean;
  intervalMs?: number;
  /** Called once when this watcher opens the pull; a throw is logged, not raised. */
  onOpened?: () => void;
}

/**
 * How a run ended without work to land. A run that errors after its pull
 * opened has pushed work, which `landWork` lands for review: only a decline
 * closes the pull.
 */
export type Ending = { kind: "declined"; sentence: string };

export interface EarlyPull {
  stop: () => Promise<void>;
  /**
   * The run is over: a pull still saying "in progress" says it ended. A
   * decline or a failure closes the pull with the reason, unless a person
   * has spoken on it: that one stays open with a comment.
   */
  settle: (ending?: Ending) => void;
}

/** A person has commented on or reviewed the pull: it is theirs to close. */
function spokenOn(app: App, pull: Pull): boolean {
  const person = (id: string): boolean =>
    getUserById(app.db, id)?.kind === "user";
  return (
    listComments(app.db, pull.id).some((c) => person(c.authorId)) ||
    listReviews(app.db, pull.id).some((r) => person(r.authorId))
  );
}

/**
 * Start watching; `stop` ends it, waiting for an open in flight. A push in
 * the last second is not looked for: `landWork` opens the pull for it.
 */
export function watchForPull(input: EarlyInput): EarlyPull {
  const log = `${input.forgeUrl}/${input.repo.ownerName}/${input.repo.name}/runs/${input.run.id}`;
  let done = input.continuing;
  let busy: Promise<void> = Promise.resolve();
  // The (base, head) pair last found level in content: judged once, not every tick.
  let level = "";
  const tick = async (): Promise<void> => {
    if (done) return;
    const head = await resolveOid(input.forkBare, `refs/heads/${input.branch}`);
    if (head === undefined || done) return;
    const base = await resolveOid(input.bare, `refs/heads/${input.repo.defaultBranch}`);
    if (base === undefined || done) return;
    if ((await aheadCount(input.forkBare, base, head)) === 0 || done) return;
    // Ahead by commits, level in content: a squash already carried it.
    if (level === `${base} ${head}`) return;
    if (await contentOnBase(input.forkBare, base, head)) {
      level = `${base} ${head}`;
      return;
    }
    if (done) return;
    // Set before the open, so a failed open is not retried every second:
    // `landWork` opens the pull at the run's end when this did not.
    done = true;
    if (pullOfBranch(input.app, input.repo, input.fork, input.branch) !== undefined)
      return;
    const opened = await openPull(input.app, input.agent.user, input.repo, {
      title: input.issue.title,
      body: `${IN_PROGRESS} @${input.agent.user.username} is still working on this; the description is filled in when the run ends. Run log: ${log}\n\n${trailerFor(input.issue)}`,
      baseBranch: input.repo.defaultBranch,
      headBranch: input.branch,
      headRepo: input.fork,
      ...(input.variantGroup === null ? {} : { variantGroup: input.variantGroup }),
    });
    input.write(
      opened.ok
        ? `opened pull #${opened.value.number} at the first push, in progress`
        : `could not open the pull early: ${JSON.stringify(opened.error)}`,
    );
    if (opened.ok && input.onOpened !== undefined) {
      try {
        input.onOpened();
      } catch (err) {
        input.write(`could not write the first-push timing: ${String(err)}`);
      }
    }
  };
  const every = input.intervalMs ?? WATCH_MS;
  let looks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (done) return;
    timer = setTimeout(
      () => {
        looks++;
        busy = busy
          .then(tick)
          .catch(() => undefined)
          .then(schedule);
      },
      looks < QUICK_LOOKS ? every : every * SLOW_FACTOR,
    );
  };
  schedule();
  return {
    settle: (ending) => {
      const pull = pullOfBranch(input.app, input.repo, input.fork, input.branch);
      if (pull === undefined) return;
      if (ending !== undefined) {
        const said = `Declined: ${ending.sentence} Run log: ${log}`;
        if (spokenOn(input.app, pull)) {
          addComment(
            input.app,
            input.agent.user,
            input.repo,
            pull,
            `${said} Left open: someone has spoken on this pull.`,
          );
          return;
        }
        if (isEarlyBody(pull.body))
          editIssue(input.app, input.agent.user, input.repo, pull, {
            body: `${said}\n\n${trailerFor(input.issue)}`,
          });
        else addComment(input.app, input.agent.user, input.repo, pull, said);
        setIssueState(input.app, input.agent.user, input.repo, pull, "closed");
        return;
      }
      if (!pull.body.startsWith(IN_PROGRESS)) return;
      editIssue(input.app, input.agent.user, input.repo, pull, {
        body: `${ENDED} Run log: ${log}\n\n${trailerFor(input.issue)}`,
      });
    },
    stop: async () => {
      clearTimeout(timer);
      done = true;
      await busy;
    },
  };
}

/**
 * The body still begins with the words the early open wrote, or `settle`
 * (a run that ended without reporting, then resumed by feedback). A person
 * who edits the body but keeps those words has it filled in over.
 */
export function isEarlyBody(body: string): boolean {
  return body.startsWith(IN_PROGRESS) || body.startsWith(ENDED);
}

/** The run is over: the early pull's body becomes the run's report. */
export function fillPull(
  app: App,
  agent: Agent,
  repo: Repo,
  pull: Pull,
  issue: Issue,
  report: string,
): void {
  if (!isEarlyBody(pull.body)) return;
  const body = `${report === "" ? "" : `${report}\n\n`}${trailerFor(issue)}`;
  editIssue(app, agent.user, repo, pull, { body });
}
