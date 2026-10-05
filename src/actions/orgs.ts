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
import { reservedName } from "../core/reserved.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireOrgAdmin, requireUser } from "./access.ts";

export function createOrg(
  app: App,
  actor: User | undefined,
  name: string,
): Result<User, "unauthorized" | "name_reserved" | CreateOrgError> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // An org shares the account namespace: it may not take a reserved name.
  // A name someone already holds is taken (foundOrg says so); only a new
  // name can be a reserved one.
  if (
    getUserByName(app.db, name) === undefined &&
    reservedName(app.db, name) !== undefined
  )
    return err("name_reserved");
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
  const created = insertTeam(app.db, org.id, name, permission);
  if (!created.ok) return created;
  app.bus.append({
    kind: "team.created",
    actorId: admin.value.id,
    payload: {
      org: org.username,
      teamId: created.value.id,
      name: created.value.name,
      permission,
    },
  });
  return created;
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
  if (!removeTeam(app.db, org.id, team.id)) return err("protected");
  app.bus.append({
    kind: "team.deleted",
    actorId: admin.value.id,
    payload: { org: org.username, teamId: team.id, name: team.name },
  });
  return ok();
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
  const added = insertMember(app.db, team, user.id);
  if (added)
    app.bus.append({
      kind: "team.member_added",
      actorId: admin.value.id,
      payload: { org: org.username, teamId: team.id, user: user.username },
    });
  return ok({ added });
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
  const removed = dropMember(app.db, team, user.id);
  if (removed)
    app.bus.append({
      kind: "team.member_removed",
      actorId: admin.value.id,
      payload: { org: org.username, teamId: team.id, user: user.username },
    });
  return ok({ removed });
}
