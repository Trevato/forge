/**
 * The way back from a red main (#6377). When main's check goes red and the
 * commits since its last green are exactly one landed pull, the forge
 * proposes the revert of that pull: one pull, `revertsPullId` set, titled
 * for the pull it takes back and naming the failing test. It is only ever
 * proposed — a person lands it. A red that spans more than one landing (or a
 * push no pull carried) is the alarm's, not this module's, and a landing
 * already reverted, open or shipped or closed, is never proposed twice.
 */

import type { App } from "../app.ts";
import { revertPull } from "../actions/revert.ts";
import { getIssueById } from "../core/issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { isSafeOid } from "../git/guard.ts";
import { manifestError, redMain, type RedMain } from "./red_main.ts";

/** The reds being answered now: a check finishing twice at once proposes once. */
const working = new Set<string>();

/** The id of the last passed default-branch check before run `below`, with its commit. */
function greenBefore(app: App, repoId: string, branch: string, below: string): string | undefined {
  return app.db
    .query<{ commit_oid: string }, [string, string, string]>(
      `SELECT commit_oid FROM run
        WHERE repo_id = ?1 AND kind = 'check' AND issue_id IS NULL AND env = ?2
          AND state = 'ok' AND id < ?3
        ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, branch, below)?.commit_oid;
}

/** Whether any pull, in any state, already takes `pullId` back. */
export function everReverted(app: App, pullId: string): boolean {
  return (
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM pull WHERE reverts_issue_id = ?1")
      .get(pullId)!.n > 0
  );
}

/**
 * The one pull landed between the last green and `red`, else undefined:
 * every first-parent commit in that range must be a pull's landing, and
 * there must be exactly one.
 */
async function soleLanding(app: App, red: RedMain, green: string): Promise<Pull | undefined> {
  const repo = getRepoById(app.db, red.repoId);
  if (repo === undefined || !isSafeOid(green) || !isSafeOid(red.commitOid)) return undefined;
  const log = await runGit(["rev-list", "--first-parent", `${green}..${red.commitOid}`], {
    cwd: repoDir(app.reposRoot, repo.ownerName, repo.name),
  });
  if (!log.ok) return undefined;
  const commits = log.value.split("\n").filter(Boolean);
  if (commits.length === 0) return undefined;
  const landed = commits.map((oid) =>
    app.db
      .query<{ number: number }, [string, string, string]>(
        `SELECT i.number FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE i.repo_id = ?1 AND p.merged_oid = ?2 AND p.base_branch = ?3`,
      )
      .get(repo.id, oid, repo.defaultBranch),
  );
  if (landed.length !== 1 || landed[0] === null || landed[0] === undefined) return undefined;
  return getPull(app.db, repo.id, landed[0].number);
}

/** What the revert pull says besides what it reverts: the red it answers. */
export function revertBody(pull: Pick<Pull, "number">, red: RedMain): string {
  const what =
    red.failing[0] !== undefined
      ? `the failing test is "${red.failing[0]}"${red.failing.length > 1 ? ` (and ${red.failing.length - 1} more)` : ""}`
      : red.summary.replace(/^check failed: /, "");
  return `Reverts #${pull.number}, the one pull landed since main was last green.\n\nMain is red at ${red.commitOid.slice(0, 7)}: ${what}.\n\nProposed by the forge; a person lands it.`;
}

/**
 * Called when a default-branch check of `repoId` has finished: opens the
 * revert pull if the rules above hold. Returns it, or undefined when none
 * was proposed.
 */
export async function proposeRevert(app: App, repoId: string): Promise<Pull | undefined> {
  if (working.has(repoId)) return undefined;
  working.add(repoId);
  try {
    const red = redMain(app.db, repoId);
    if (red === undefined || red.limit || manifestError(red) !== undefined) return undefined;
    const green = greenBefore(app, repoId, red.branch, red.runId);
    if (green === undefined) return undefined;
    const landed = await soleLanding(app, red, green);
    if (landed === undefined || everReverted(app, landed.id)) return undefined;
    const repo = getRepoById(app.db, repoId);
    const owner = repo === undefined ? undefined : getUserById(app.db, repo.ownerId);
    if (repo === undefined || owner === undefined || getIssueById(app.db, landed.id) === undefined)
      return undefined;
    const made = await revertPull(app, owner, repo, landed, revertBody(landed, red));
    return made.ok ? made.value : undefined;
  } finally {
    working.delete(repoId);
  }
}
