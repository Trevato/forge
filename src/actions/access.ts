/**
 * Authorization vocabulary shared by every action. Three tiers, one rule
 * each, and one deliberate ambiguity: a repo you cannot read does not exist
 * for you (`not_found`), so private repos never leak. A repo you can read but
 * not write is `forbidden` — nothing is hidden by refusing. Admin surfaces
 * (settings, webhooks, teams) are hidden entirely, like the pages that carry
 * them: a non-admin gets `not_found`, never a hint that there is a door.
 */

import type { App } from "../app.ts";
import { accessAllows, orgAccess } from "../core/orgs.ts";
import { canAdmin, canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type AccessError = "unauthorized" | "forbidden" | "not_found";

/** Any signed-in actor. */
export function requireUser(
  actor: User | undefined,
): Result<User, "unauthorized"> {
  return actor ? ok(actor) : err("unauthorized");
}

/** A repo the actor may see. Anonymous readers are fine for public repos. */
export function requireReader(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<Repo, "not_found"> {
  return canRead(app.db, repo, actor) ? ok(repo) : err("not_found");
}

/** A signed-in actor who may see the repo — the floor for opening issues,
 * commenting, and forking. */
export function requireParticipant(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, "not_found" | "unauthorized"> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  return requireUser(actor);
}

export function requireWriter(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, AccessError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (!actor) return err("unauthorized");
  return canWrite(app.db, repo, actor) ? ok(actor) : err("forbidden");
}

export function requireRepoAdmin(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, "not_found"> {
  return actor && canAdmin(app.db, repo, actor) ? ok(actor) : err("not_found");
}

/** An admin of `org` (a user row of kind "org"). */
export function requireOrgAdmin(
  app: App,
  actor: User | undefined,
  org: User,
): Result<User, "not_found"> {
  if (org.kind !== "org") return err("not_found");
  if (!actor || !accessAllows(orgAccess(app.db, org.id, actor), "admin"))
    return err("not_found");
  return ok(actor);
}
