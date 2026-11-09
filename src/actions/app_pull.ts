/**
 * Pull now (#10084): a writer runs one adapter pull through the same path as
 * the schedule (`apps/pull_schedule.ts`), without waiting for
 * `schedule.every`. Shared by `POST …/app/pull` and the MCP `app_deploy`
 * tool's `pull` action. A sleeping app is refused, never woken.
 */

import type { App } from "../app.ts";
import { pullAppNow, runtimePullReach, type PullReach, type PullRefusal } from "../apps/pull_schedule.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import type { Repo } from "../core/repos.ts";
import type { PullRun } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

/** Why a pull now was refused: access, no app, or the refusals the schedule shares (a pull now is never held as "not due"). */
export type PullNowError = AccessError | PullRefusal;

/** What a person is told when a pull now is refused, the same on every surface. */
export const PULL_NOW_REFUSALS: Readonly<Record<PullNowError, string>> = {
  unauthorized: "Sign in to pull an adapter.",
  forbidden: "You need write access to do that.",
  not_found: "This repository has no app.",
  asleep: "The app's production is not running; it is not woken for a pull. Redeploy it first.",
  in_flight: "A pull of this app is already running.",
  no_adapter: "This app's forge.json on the default branch has no adapter block.",
};

/** Run one pull of the repository's app now: the recorded run, or why not. `reachOf` is the seam a test replaces. */
export async function pullNow(
  app: App,
  actor: User | undefined,
  repo: Repo,
  reachOf: (record: AppRecord) => PullReach = (record) => runtimePullReach(app, record),
): Promise<Result<PullRun, PullNowError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  const pulled = await pullAppNow(app.db, record.id, reachOf(record));
  return pulled.ok ? ok(pulled.run) : err(pulled.why);
}
