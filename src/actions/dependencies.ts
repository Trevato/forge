/**
 * Linking issues, with who may. A plan is written by whoever can write the
 * repository and by its crew: a planner agent's whole job is to open issues
 * and link them, so crew membership is enough here, where it is not for
 * assigning (which spends money) or merging (which is a person's call).
 */

import type { App } from "../app.ts";
import { isCrew } from "../core/agents.ts";
import {
  addDependency,
  confirmDependency,
  removeDependency,
  type DependencyError,
} from "../core/dependencies.ts";
import type { Issue } from "../core/issues.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AccessError } from "./access.ts";
import { followLink } from "./pillars.ts";

/** What a refused link says, in the words the API and the MCP share. */
export const dependencyWords: Record<string, string> = {
  self: "an issue cannot wait for itself",
  cycle: "that would make a loop",
  cross_repo: "dependencies stay inside one repository",
  not_an_issue: "only issues can depend on issues",
};

function requirePlanner(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, AccessError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (!actor) return err("unauthorized");
  if (canWrite(app.db, repo, actor) || isCrew(app.db, repo.id, actor.id))
    return ok(actor);
  return err("forbidden");
}

/** `issue` now waits for `blocker`. */
export function linkIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  blocker: Issue,
): Result<void, AccessError | DependencyError> {
  const who = requirePlanner(app, actor, repo);
  if (!who.ok) return who;
  if (issue.repoId !== repo.id || blocker.repoId !== repo.id)
    return err("not_found");
  const linked = addDependency(app.db, issue, blocker, who.value.id);
  if (!linked.ok) return linked;
  app.bus.append({
    kind: "issue.blocked",
    repoId: repo.id,
    actorId: who.value.id,
    payload: { number: issue.number, blockedBy: blocker.number },
  });
  // Under a pillar's umbrella, or behind the gate, the label follows.
  followLink(app, who.value, repo, issue, blocker);
  return ok(undefined);
}

/** `issue` no longer waits for `blocker`. */
export function unlinkIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  blocker: Issue,
): Result<void, AccessError> {
  const who = requirePlanner(app, actor, repo);
  if (!who.ok) return who;
  if (issue.repoId !== repo.id) return err("not_found");
  if (!removeDependency(app.db, issue.id, blocker.id)) return ok(undefined);
  app.bus.append({
    kind: "issue.unblocked",
    repoId: repo.id,
    actorId: who.value.id,
    payload: { number: issue.number, blockedBy: blocker.number },
  });
  followLink(app, who.value, repo, issue, blocker);
  return ok(undefined);
}

/**
 * A person says `issue` may go ahead although `blocker` closed as dropped or
 * split. Writers only: the crew parked it, and the crew may not unpark itself.
 */
export function confirmIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  blocker: Issue,
): Result<void, AccessError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (!actor) return err("unauthorized");
  if (!canWrite(app.db, repo, actor) || isCrew(app.db, repo.id, actor.id))
    return err("forbidden");
  if (issue.repoId !== repo.id) return err("not_found");
  if (!confirmDependency(app.db, issue.id, blocker.id)) return ok(undefined);
  app.bus.append({
    kind: "issue.confirmed",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: issue.number, blockedBy: blocker.number },
  });
  return ok(undefined);
}
