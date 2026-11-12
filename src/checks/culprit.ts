/**
 * What a finished verification after landing does next (#7786,
 * `checks/verify.ts`). Green: nothing. Red, with the test files it failed
 * named: the range since the last green verification is bisected one step
 * at a time — each step a run of only those files, in the verification
 * lane — until one commit is left. That commit is the culprit: the landed
 * pull it is gets its revert proposed (a person lands it, as every revert),
 * a push no pull carried gets one issue. A red whose files were already red
 * at the verification before it was named there and starts nothing.
 *
 * A later green verification that ran every file such an issue names
 * closes it as done (#11395), unless a person has commented on it.
 *
 * Called by the checks service with the way it asks for a run; the answer
 * is the lines for the finished run's log.
 */

import type { App } from "../app.ts";
import { revertPull } from "../actions/revert.ts";
import { addComment, createIssue, setIssueState } from "../core/issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { getRun, type Run } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { everReverted } from "./revert_red.ts";
import {
  BISECT_ENV,
  BISECT_PREFIX,
  bisectOrigin,
  MAX_RANGE,
  maxSteps,
  nextStep,
  VERIFY_ENV,
} from "./verify.ts";

/** How the service asks for a bisection step. */
export type Ask = (repo: Repo, env: string, commitOid: string, reason: string) => Promise<Run | undefined>;

/** The machine says so: the author is the owner, the text is not theirs. */
const FILED_BY = "_Filed by the forge's verification after landing, not written by a person._";

const short = (oid: string): string => oid.slice(0, 7);

/** How every issue this module files is titled. */
const TITLE_PREFIX = "Red after landing: ";


/** The last green verification before run `below`. */
function greenBefore(app: App, repoId: string, below: string): Run | undefined {
  const row = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE repo_id = ?1 AND kind = 'check' AND env = '${VERIFY_ENV}'
          AND state = 'ok' AND id < ?2 ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, below);
  return row === null ? undefined : getRun(app.db, row.id);
}

/** The finished verification just before run `below`, green or red. */
function finishedBefore(app: App, repoId: string, below: string): Run | undefined {
  const row = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE repo_id = ?1 AND kind = 'check' AND env = '${VERIFY_ENV}'
          AND state IN ('ok','failed') AND id < ?2 ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, below);
  return row === null ? undefined : getRun(app.db, row.id);
}

/** What each finished step of `origin`'s bisection said, by commit: green or not. */
function stepsOf(app: App, repoId: string, origin: string): { green: Map<string, boolean>; vague: Run | undefined } {
  const rows = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE repo_id = ?1 AND kind = 'check' AND env = '${BISECT_ENV}'
          AND reason = ?2 AND state IN ('ok','failed') ORDER BY id`,
    )
    .all(repoId, `${BISECT_PREFIX}${origin}`);
  const green = new Map<string, boolean>();
  let vague: Run | undefined;
  for (const { id } of rows) {
    const step = getRun(app.db, id);
    if (step === undefined) continue;
    // A step red for a reason that names no test (an install, the budget)
    // says nothing about the files: the bisection cannot go on from it.
    if (step.state === "failed" && (step.checkDetail?.files ?? []).length === 0) vague = step;
    green.set(step.commitOid, step.state === "ok");
  }
  return { green, vague };
}

/** First-parent commits after `green` up to `red`, oldest first; undefined when git cannot say. */
async function rangeOf(app: App, repo: Repo, green: string, red: string): Promise<string[] | undefined> {
  if (!isSafeOid(green) || !isSafeOid(red)) return undefined;
  const log = await runGit(["rev-list", "--first-parent", "--reverse", `${green}..${red}`], {
    cwd: repoDir(app.reposRoot, repo.ownerName, repo.name),
  });
  return log.ok ? log.value.split("\n").filter(Boolean) : undefined;
}

/** The pull whose landing is `oid` on the default branch, if one is. */
function landingOf(app: App, repo: Repo, oid: string): Pull | undefined {
  const row = app.db
    .query<{ number: number }, [string, string, string]>(
      `SELECT i.number FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_oid = ?2 AND p.base_branch = ?3`,
    )
    .get(repo.id, oid, repo.defaultBranch);
  return row === null ? undefined : getPull(app.db, repo.id, row.number);
}

/** What the red is, in a sentence: its first failing test and how many more. */
function redSays(red: Run): string {
  const names = red.checkDetail?.names ?? [];
  const files = red.checkDetail?.files ?? [];
  if (names[0] !== undefined)
    return `"${names[0]}"${names.length > 1 ? ` and ${names.length - 1} more` : ""} in ${files.map((f) => `\`${f}\``).join(", ")}`;
  return files.map((f) => `\`${f}\``).join(", ");
}

/** One open issue per title: a second red of the same thing adds nothing. */
function fileOnce(app: App, repo: Repo, title: string, body: string): string {
  const open = app.db
    .query<{ number: number }, [string, string]>(
      "SELECT number FROM issue WHERE repo_id = ?1 AND title = ?2 AND state = 'open' LIMIT 1",
    )
    .get(repo.id, title);
  if (open !== null) return `already filed: #${open.number}`;
  const made = createIssue(app.db, { repoId: repo.id, authorId: repo.ownerId, title, body });
  if (!made.ok) return `not filed: ${made.error}`;
  app.bus.append({
    kind: "issue.opened",
    repoId: repo.id,
    actorId: repo.ownerId,
    payload: { number: made.value.number },
  });
  return `filed #${made.value.number}: ${title}`;
}

/** Names `culprit` as what turned `red` red: the revert of its pull, or one issue. */
async function name(app: App, repo: Repo, red: Run, culprit: string, green: string, tried: number): Promise<string> {
  const files = red.checkDetail?.files ?? [];
  const how =
    tried === 0
      ? `the one commit since main was last verified green at ${short(green)}`
      : `found by bisecting ${short(green)}..${short(red.commitOid)} in ${tried} step${tried === 1 ? "" : "s"}`;
  const pull = landingOf(app, repo, culprit);
  if (pull !== undefined) {
    if (everReverted(app, pull.id)) return `culprit #${pull.number} (${short(culprit)}): its revert was already proposed`;
    const owner = getUserById(app.db, repo.ownerId);
    const body =
      `Reverts #${pull.number}: verifying main after landing found it broke ${redSays(red)} — ${how}.\n\n` +
      `Main's verification ${red.id} is red at ${short(red.commitOid)}; each failed test fails alone too.\n\n` +
      `Proposed by the forge; a person lands it.\n\nFiles: ${files.join(", ")}`;
    const made = await revertPull(app, owner, repo, pull, body);
    return made.ok
      ? `culprit #${pull.number} (${short(culprit)}): proposed its revert, #${made.value.number}`
      : `culprit #${pull.number} (${short(culprit)}): the revert could not be proposed (${made.error})`;
  }
  const title = `${TITLE_PREFIX}${short(culprit)} broke ${files[0] ?? "main"}`;
  return `culprit ${short(culprit)}, landed by no pull: ${fileOnce(
    app,
    repo,
    title,
    `${FILED_BY}\n\nCommit ${culprit} broke ${redSays(red)} — ${how}. No pull carried it, so there is no revert pull to propose: revert or fix it by hand.\n\nFiles: ${files.join(", ")}`,
  )}`;
}

/** A range the bisection will not walk, named in one issue. */
function unbisected(app: App, repo: Repo, red: Run, why: string): string {
  const files = red.checkDetail?.files ?? [];
  return `not bisected (${why}): ${fileOnce(
    app,
    repo,
    `${TITLE_PREFIX}${files[0] ?? "main"} fails on ${repo.defaultBranch}`,
    `${FILED_BY}\n\nMain's verification ${red.id} is red at ${short(red.commitOid)}: ${redSays(red)}, failing alone too. The forge did not name the landing that broke it: ${why}.\n\nFiles: ${files.join(", ")}`,
  )}`;
}

/**
 * The next thing after `run`, a finished verification or bisection step,
 * as lines for its log. Never throws into the check.
 */
export async function afterVerify(app: App, repo: Repo, run: Run, ask: Ask): Promise<string[]> {
  const red = run.env === VERIFY_ENV ? run : getRun(app.db, bisectOrigin(run.reason) ?? "");
  if (red === undefined || red.state !== "failed") return [];
  const files = red.checkDetail?.files ?? [];
  if (files.length === 0) return ["not bisected: the red names no failed test file"];
  if (run === red) {
    const before = finishedBefore(app, repo.id, red.id);
    const known = before?.state === "failed" ? (before.checkDetail?.files ?? []) : [];
    if (known.length > 0 && files.every((f) => known.includes(f)))
      return [`not bisected: ${files.join(", ")} already failed at ${short(before!.commitOid)}, named there`];
  }
  const green = greenBefore(app, repo.id, red.id);
  if (green === undefined) return [unbisected(app, repo, red, "main was never verified green before")];
  const range = await rangeOf(app, repo, green.commitOid, red.commitOid);
  if (range === undefined || range.length === 0)
    return [unbisected(app, repo, red, `git could not list ${short(green.commitOid)}..${short(red.commitOid)}`)];
  if (range.length > MAX_RANGE)
    return [unbisected(app, repo, red, `${range.length} commits since the last green is over ${MAX_RANGE}`)];
  const { green: tried, vague } = stepsOf(app, repo.id, red.id);
  if (vague !== undefined)
    return [unbisected(app, repo, red, `the step at ${short(vague.commitOid)} failed without naming a test`)];
  const step = nextStep(range, tried);
  if (step === undefined) return [];
  if (step.kind === "culprit") return [await name(app, repo, red, step.commit, green.commitOid, tried.size)];
  const asked = await ask(repo, BISECT_ENV, step.commit, `${BISECT_PREFIX}${red.id}`);
  return asked === undefined
    ? [`bisect: ${short(step.commit)} could not be asked for`]
    : [
        `bisect: trying ${short(step.commit)}, ${range.length} commit(s) since ${short(green.commitOid)}, ` +
          `at most ${maxSteps(range.length)} step(s); run ${asked.id}`,
      ];
}

/** The files an issue's closing `Files:` line names; empty when it has none. */
function filesNamed(body: string): string[] {
  const line = /\nFiles: ([^\n]+)$/.exec(body);
  return line === null ? [] : line[1]!.split(",").map((f) => f.trim()).filter(Boolean);
}

/**
 * The lines for a green verification's log: one per open 'Red after
 * landing' issue this module filed before `run` was asked for, whose every
 * named file `run` printed passing (`verify.ts` `passedFiles`), commented on
 * and closed as done (#11395). An issue a person (any account not an agent)
 * has commented on stays open: the comment is their ask. Only an issue the
 * forge filed is closed: its title, the owner as author and its opening line.
 */
export function closeOnGreen(app: App, repo: Repo, run: Run, passed: readonly string[]): string[] {
  if (run.env !== VERIFY_ENV || run.state !== "ok" || passed.length === 0) return [];
  const open = app.db
    .query<{ id: string; number: number; title: string; body: string }, [string, string, string, string]>(
      `SELECT issue.id, issue.number, issue.title, issue.body FROM issue
        WHERE issue.repo_id = ?1 AND issue.kind = 'issue' AND issue.state = 'open'
          AND issue.author_id = ?2 AND issue.title LIKE ?3 AND issue.created_at < ?4
          AND NOT EXISTS (SELECT 1 FROM comment JOIN user ON user.id = comment.author_id
                           WHERE comment.issue_id = issue.id AND user.is_agent = 0)
        ORDER BY issue.number`,
    )
    .all(repo.id, repo.ownerId, `${TITLE_PREFIX}%`, run.createdAt);
  const where = `verification ${run.id} at ${short(run.commitOid)}`;
  const lines: string[] = [];
  for (const issue of open) {
    if (!issue.title.startsWith(TITLE_PREFIX) || !issue.body.startsWith(FILED_BY)) continue;
    const files = filesNamed(issue.body);
    if (files.length === 0 || !files.every((f) => passed.includes(f))) continue;
    const body = `Green again: main's ${where} ran and passed ${files.map((f) => `\`${f}\``).join(", ")}.`;
    const noted = addComment(app.db, { issueId: issue.id, authorId: repo.ownerId, body });
    if (noted.ok)
      app.bus.append({
        kind: "issue.commented",
        repoId: repo.id,
        actorId: repo.ownerId,
        payload: { number: issue.number, body, commentId: noted.value.id },
      });
    if (setIssueState(app.db, issue.id, "closed", "done") === undefined) continue;
    app.bus.append({ kind: "issue.closed", repoId: repo.id, actorId: repo.ownerId, payload: { number: issue.number } });
    lines.push(`culprit: closed #${issue.number}, ${files.join(", ")} green again`);
  }
  return lines;
}
