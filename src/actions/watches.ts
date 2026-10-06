/**
 * Start or stop watching a milestone (#732). A person watches for
 * themselves, in a repository they can read; an agent has no feed and no
 * phone, so it does not. The watch is the person's own state
 * (`core/watches.ts`): no event is appended and nobody else is told.
 */

import type { App } from "../app.ts";
import { readPlan } from "../core/milestones.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isWatching, setWatch } from "../core/watches.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type WatchError = "unauthorized" | "forbidden" | "not_found";

/**
 * Watch (`on`) or stop watching the milestone of this number. One answer
 * for a repository that cannot be seen and an issue that is no milestone.
 */
export function watchMilestone(
  app: App,
  actor: User | undefined,
  repo: Repo,
  number: number,
  on: boolean,
): Result<{ watching: boolean }, WatchError> {
  if (!actor) return err("unauthorized");
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (actor.kind !== "user") return err("forbidden");
  const milestone = Number.isInteger(number)
    ? readPlan(app.db, repo).milestone(number)
    : undefined;
  if (milestone === undefined) return err("not_found");
  setWatch(app.db, actor.id, milestone.issue.id, on);
  return ok({ watching: isWatching(app.db, actor.id, milestone.issue.id) });
}
