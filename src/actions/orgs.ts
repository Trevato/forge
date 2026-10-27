/**
 * Organization actions: founding an org and running its teams. Team
 * management is admin-only and the admin surface is hidden — a non-admin
 * gets `not_found`, the same as the pages that carry these forms.
 */

import { NAME_RESERVED } from "./signup_words.ts";
import { requireVerified, UNVERIFIED_MESSAGE } from "./verify.ts";
import type { App } from "../app.ts";
import {
  addTeamMember as insertMember,
  createOrg as foundOrg,
  createTeam as insertTeam,
  deleteTeam as removeTeam,
  isLastOwner,
  OWNERS_TEAM,
  removeTeamMember as dropMember,
  type CreateOrgError,
  type CreateTeamError,
  type Permission,
  type Team,
} from "../core/orgs.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireOrgAdmin, requireUser } from "./access.ts";

export type CreateOrgRefusal =
  | "unauthorized"
  | "unverified"
  | "agent_cannot_own"
  | CreateOrgError;

/**
 * What `createOrg`'s refusal says, on every door: the new-organization
 * page, MCP `org_create` and the terminal read it from here.
 */
export function createOrgWords(error: CreateOrgRefusal): string {
  const words: Record<CreateOrgRefusal, string> = {
    name_taken: "That name is already taken.",
    name_reserved: NAME_RESERVED,
    invalid_name: "Letters, digits, dots and dashes only.",
    unauthorized: "Sign in to create an organization.",
    unverified: `${UNVERIFIED_MESSAGE[0]!.toUpperCase()}${UNVERIFIED_MESSAGE.slice(1)}: an unverified account cannot make an organization.`,
    agent_cannot_own: "An agent cannot own an organization.",
  };
  return words[error];
}

export function createOrg(
  app: App,
  actor: User | undefined,
  name: string,
): Result<User, CreateOrgRefusal> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // Its founder is its first owner, and an agent never owns one.
  if (user.value.kind === "agent") return err("agent_cannot_own");
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  // A reserved name is refused where orgs are made (`core/orgs.ts`).
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
): Result<
  { added: boolean },
  "not_found" | "no_such_user" | "agent_cannot_own"
> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  if (team.orgId !== org.id) return err("not_found");
  const user = getUserByName(app.db, username);
  if (!user || user.kind === "org") return err("no_such_user");
  // An agent is never admin (CLAUDE.md, invariant 10): not on Owners, not on
  // any team that confers admin.
  if (user.kind === "agent" && team.permission === "admin")
    return err("agent_cannot_own");
  const added = insertMember(app.db, team, user.id);
  if (added)
    app.bus.append({
      kind: "team.member_added",
      actorId: admin.value.id,
      payload: { org: org.username, teamId: team.id, user: user.username },
    });
  return ok({ added });
}

/**
 * Removing the last person who owns the organization is refused, with
 * `last_owner`: it would be left with nobody who can administer it. An
 * agent never counts as that owner.
 */
export function removeTeamMember(
  app: App,
  actor: User | undefined,
  org: User,
  team: Team,
  username: string,
): Result<{ removed: boolean }, "not_found" | "no_such_user" | "last_owner"> {
  const admin = requireOrgAdmin(app, actor, org);
  if (!admin.ok) return admin;
  if (team.orgId !== org.id) return err("not_found");
  const user = getUserByName(app.db, username);
  if (!user) return err("no_such_user");
  if (team.name === OWNERS_TEAM && isLastOwner(app.db, org.id, user))
    return err("last_owner");
  const removed = dropMember(app.db, team, user.id);
  if (removed)
    app.bus.append({
      kind: "team.member_removed",
      actorId: admin.value.id,
      payload: { org: org.username, teamId: team.id, user: user.username },
    });
  return ok({ removed });
}
