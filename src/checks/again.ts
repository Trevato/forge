/**
 * A check asked for again by a person: the pull's head as it is now, judged
 * as a push would have, so a parked pull can be re-judged without one.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Run } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { checksFor } from "./service.ts";

export type Asked =
  | { ok: true; run: Run }
  | { ok: false; error: "no_checks" | "not_open" | "no_check_declared"; message: string };

export async function askCheck(
  app: App,
  user: User,
  repo: Repo,
  pull: Pull,
): Promise<Asked> {
  if (pull.state !== "open")
    return { ok: false, error: "not_open", message: "only an open pull is checked" };
  const checks = checksFor(app);
  if (checks === undefined)
    return { ok: false, error: "no_checks", message: "this forge runs no checks" };
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const ref = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  const head = (await resolveOid(dir, ref)) ?? pull.headOid;
  const run =
    head === ""
      ? undefined
      : await checks.request(repo, `pull-${pull.number}`, head, "asked", pull.id, user.id);
  if (run === undefined)
    return {
      ok: false,
      error: "no_check_declared",
      message: "this head declares no check, or waits for a writer's approval",
    };
  return { ok: true, run };
}
