/**
 * Every open pull whose latest check on its current head failed on one
 * named test, asked for again (#6445): once a shared red is fixed on main,
 * the pulls it held are handed back to the check queue in one call.
 */

import type { App } from "../app.ts";
import { listOpenPulls, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { getRun, type Run } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { askCheck } from "./again.ts";

/** The most pulls one call queues. */
export const RECHECK_MAX = 50;

/** The longest test name taken. */
export const TEST_NAME_MAX = 300;

export interface Rechecked {
  readonly queued: number[];
  /** Red pulls beyond `RECHECK_MAX`, left for the next call. */
  readonly left: number;
}

/** The newest check run of this head of the pull. */
function latestCheck(app: App, pull: Pull): Run | undefined {
  const row = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE kind = 'check' AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC LIMIT 1`,
    )
    .get(pull.id, pull.headOid);
  return row === null ? undefined : getRun(app.db, row.id)!;
}

export async function recheckNamed(
  app: App,
  user: User,
  repo: Repo,
  test: string,
  max = RECHECK_MAX,
): Promise<Rechecked> {
  const red = listOpenPulls(app.db, repo.id).filter((pull) => {
    if (pull.headOid === "") return false;
    const run = latestCheck(app, pull);
    return run?.state === "failed" && (run.checkDetail?.names.includes(test) ?? false);
  });
  const queued: number[] = [];
  for (const pull of red.slice(0, max)) {
    // The ordinary request: the check queue's own slots and order apply.
    const asked = await askCheck(app, user, repo, pull);
    if (asked.ok) queued.push(pull.number);
  }
  return { queued, left: Math.max(0, red.length - max) };
}
