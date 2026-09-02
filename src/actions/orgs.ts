/**
 * Organization actions: founding an org and running its teams. Team
 * management is admin-only and the admin surface is hidden — a non-admin
 * gets `not_found`, the same as the pages that carry these forms.
 */

import type { App } from "../app.ts";
import {
  addTeamMember as insertMember,
  createOrg as foundOrg,
  createTeam as insertTeam,
  deleteTeam as removeTeam,
  removeTeamMember as dropMember,
  type CreateOrgError,
  type CreateTeamError,
  type Permission,
  type Team,
} from "../core/orgs.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireOrgAdmin, requireUser } from "./access.ts";

export function createOrg(
  app: App,
  actor: User | undefined,
  name: string,
): Result<User, "unauthorized" | CreateOrgError> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const created = foundOrg(app.db, name, user.value.id);
  if (!created.ok) return created;
  app.bus.append({
    kind: "org.created",
    actorId: user.value.id,
    payload: { org: created.value.username },
  });
  return created;
}

export function createTeam(
  app: App,
  actor: User | undefined,
  org: User,
  name: string,
  permission: Permission,
): Result<Team, "not_found" | CreateTeamError> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  return insertTeam(app.db, org.id, name, permission);
}

/** The Owners team cannot be deleted — an org must keep its admins. */
export function deleteTeam(
  app: App,
  actor: User | undefined,
  org: User,
  team: Team,
): Result<void, "not_found" | "protected"> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  if (team.orgId !== org.id) return err("not_found");
  return removeTeam(app.db, org.id, team.id) ? ok() : err("protected");
}

export function addTeamMember(
  app: App,
  actor: User | undefined,
  org: User,
  team: Team,
  username: string,
): Result<{ added: boolean }, "not_found" | "no_such_user"> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  if (team.orgId !== org.id) return err("not_found");
  const user = getUserByName(app.db, username);
  if (!user || user.kind === "org") return err("no_such_user");
  return ok({ added: insertMember(app.db, team, user.id) });
}

/** Removing the last owner is refused — the org would have no admin left. */
export function removeTeamMember(
  app: App,
  actor: User | undefined,
  org: User,
  team: Team,
  username: string,
): Result<{ removed: boolean }, "not_found" | "no_such_user"> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  if (team.orgId !== org.id) return err("not_found");
  const user = getUserByName(app.db, username);
  if (!user) return err("no_such_user");
  return ok({ removed: dropMember(app.db, team, user.id) });
}
