/**
 * Crew actions: create, change and retire agents (a forge admin's job — an
 * agent is an account that acts), and put agents on or take them off a
 * repository's crew (a repository admin's job). Every agent is a user, so
 * everything else about it — its pulls, its comments, its tokens — is
 * handled where users are.
 */

import { requireVerified } from "./verify.ts";
import type { App } from "../app.ts";
import {
  addCrew as insertCrew,
  createAgentRow,
  deleteAgent as removeAgent,
  getAgent,
  getAgentByName,
  isCrew,
  listAgents,
  listCrew as queryCrew,
  isCrewRole,
  listCrewRoles,
  removeCrew as deleteCrew,
  seatsOutside,
  updateAgent as patchAgent,
  type Agent,
  type AgentPatch,
  type CrewRole,
  BRIEF_MAX,
  MODEL_MAX,
} from "../core/agents.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import {
  createUser,
  getUserByName,
  type CreateUserError,
  type User,
} from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireReader, requireRepoAdmin, requireUser } from "./access.ts";
import { limitValue } from "../settings/limits.ts";

export interface CreateAgentInput {
  username: string;
  /** @default the username */
  displayName?: string;
  model?: string;
  brief?: string;
  budgetUsd?: number;
  /** The seats it can hold: any of planner, builder, reviewer. */
  roles?: readonly string[];
}

/** An agent change as asked: roles still unchecked strings. */
export type AgentChange = Omit<AgentPatch, "roles"> & { roles?: readonly string[] };

/**
 * The `roles` a request named, as a patch field: nothing when it named none;
 * anything but a list of strings is carried as a value checkPatch refuses.
 */
export function askedRoles(value: unknown): { roles?: readonly string[] } {
  if (value === undefined) return {};
  return {
    roles:
      Array.isArray(value) && value.every((r) => typeof r === "string")
        ? value
        : [""],
  };
}

export type CreateAgentError =
  | "unauthorized"
  | "forbidden"
  | CreateUserError
  | "invalid_model"
  | "brief_too_long"
  | "invalid_budget"
  | "invalid_roles"
  | "role_held";

function requireForgeAdmin(
  actor: User | undefined,
): Result<User, "unauthorized" | "forbidden"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  return user.value.isAdmin ? user : err("forbidden");
}

/** The bounds an agent change must meet; the screens check them before they ask. */
export function checkPatch(
  app: App,
  patch: AgentChange,
): Result<AgentPatch, "invalid_model" | "brief_too_long" | "invalid_budget" | "invalid_roles"> {
  let roles: CrewRole[] | undefined;
  if (patch.roles !== undefined) {
    if (patch.roles.length === 0 || !patch.roles.every(isCrewRole)) return err("invalid_roles");
    roles = patch.roles as CrewRole[];
  }
  if (patch.model !== undefined) {
    if (patch.model.length > MODEL_MAX || /[\s\0]/.test(patch.model))
      return err("invalid_model");
  }
  if (patch.brief !== undefined && patch.brief.length > BRIEF_MAX)
    return err("brief_too_long");
  if (
    patch.budgetUsd !== undefined &&
    (!Number.isFinite(patch.budgetUsd) ||
      patch.budgetUsd < 0 ||
      patch.budgetUsd > limitValue(app.db, "agent.budget_max_usd"))
  )
    return err("invalid_budget");
  const { roles: _asked, ...rest } = patch;
  return ok({ ...rest, ...(roles === undefined ? {} : { roles }) });
}

/** A new crew member. Admin only: this is an account that will act. */
export async function createAgent(
  app: App,
  actor: User | undefined,
  input: CreateAgentInput,
): Promise<Result<Agent, CreateAgentError>> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const patch = checkPatch(app, {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
    ...(input.roles === undefined ? {} : { roles: input.roles }),
  });
  if (!patch.ok) return patch;
  const user = await createUser(app.db, {
    username: input.username,
    email: `${input.username.toLowerCase()}@agents.invalid`,
    password: "",
    displayName: input.displayName ?? input.username,
    agent: true,
    origin: "agent",
  });
  if (!user.ok) return user;
  const agent = createAgentRow(app.db, {
    userId: user.value.id,
    model: patch.value.model,
    brief: patch.value.brief,
    budgetUsd: patch.value.budgetUsd,
    roles: patch.value.roles,
    createdBy: admin.value.id,
  });
  app.bus.append({
    kind: "agent.created",
    actorId: admin.value.id,
    payload: { agent: agent.user.username },
  });
  return ok(agent);
}

export function updateAgent(
  app: App,
  actor: User | undefined,
  username: string,
  patch: AgentChange,
): Result<Agent, CreateAgentError | "not_found"> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const agent = getAgentByName(app.db, username);
  if (!agent) return err("not_found");
  const checked = checkPatch(app, patch);
  if (!checked.ok) return checked;
  // No silent move: a seat the agent still holds on a repository is moved there first.
  if (checked.value.roles) {
    const held = seatsOutside(app.db, agent.user.id, checked.value.roles);
    if (held.length > 0) return err("role_held");
  }
  const updated = patchAgent(app.db, agent.user.id, checked.value);
  if (!updated) return err("not_found");
  app.bus.append({
    kind: "agent.updated",
    actorId: admin.value.id,
    payload: { agent: updated.user.username },
  });
  return ok(updated);
}

export function deleteAgent(
  app: App,
  actor: User | undefined,
  username: string,
): Result<void, "unauthorized" | "forbidden" | "not_found"> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const agent = getAgentByName(app.db, username);
  if (!agent) return err("not_found");
  if (!removeAgent(app.db, agent.user.id)) return err("not_found");
  app.bus.append({
    kind: "agent.deleted",
    actorId: admin.value.id,
    payload: { agent: agent.user.username },
  });
  return ok();
}

/** Every agent on the forge. Anyone signed in may see who is on the crew. */
export function listAllAgents(
  app: App,
  actor: User | undefined,
): Result<Agent[], "unauthorized"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  return ok(listAgents(app.db));
}

export function getAgentView(
  app: App,
  actor: User | undefined,
  username: string,
): Result<Agent, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const agent = getAgentByName(app.db, username);
  return agent ? ok(agent) : err("not_found");
}

// ---- a repository's crew ----

export function listCrew(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<Agent[], "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  return ok(queryCrew(app.db, repo.id));
}

/** One crew member as a viewer may see it: always who and what they do. */
export interface CrewMember {
  readonly username: string;
  readonly displayName: string;
  readonly role: CrewRole;
  /**
   * The owner's configuration of the agent (#946): its brief, model and
   * budget. Only the repository's writers and its own crew see it; a reader
   * or a stranger sees the crew's names and roles.
   */
  readonly config?: { model: string; brief: string; budgetUsd: number };
  /** The seats the agent declares; the repository's `role` is one of them. */
  readonly roles: readonly CrewRole[];
}

/** The crew of a repository, shown as `actor` may see it. */
export function crewAsSeen(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<CrewMember[], "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  const configured =
    actor !== undefined &&
    (canWrite(app.db, repo, actor) ||
      (actor.kind === "agent" && isCrew(app.db, repo.id, actor.id)));
  return ok(
    listCrewRoles(app.db, repo.id).map(({ agent, role }) => ({
      username: agent.user.username,
      displayName: agent.user.displayName,
      role,
      roles: agent.roles,
      ...(configured
        ? {
            config: {
              model: agent.model,
              brief: agent.brief,
              budgetUsd: agent.budgetUsd,
            },
          }
        : {}),
    })),
  );
}

/** Put an agent on the crew: it may now read and write this repository. */
export function addToCrew(
  app: App,
  actor: User | undefined,
  repo: Repo,
  username: string,
  role?: CrewRole,
): Result<Agent, "not_found" | "no_such_agent" | "not_an_agent" | "unverified" | "role_not_declared"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const proven = requireVerified(app, admin.value);
  if (!proven.ok) return proven;
  const agent = getAgentByName(app.db, username);
  // A person is never on a crew: said plainly, before the database would.
  if (!agent)
    return err(getUserByName(app.db, username) ? "not_an_agent" : "no_such_agent");
  // A repository narrows what an agent declares, never widens it.
  if (role !== undefined && !agent.roles.includes(role)) return err("role_not_declared");
  // A seat is named only for an agent who joins now; one already on the crew keeps its role.
  if (insertCrew(app.db, repo.id, agent.user.id, admin.value.id, role)) {
    app.bus.append({
      kind: "crew.added",
      repoId: repo.id,
      actorId: admin.value.id,
      payload: { agent: agent.user.username },
    });
  }
  return ok(agent);
}

export function removeFromCrew(
  app: App,
  actor: User | undefined,
  repo: Repo,
  username: string,
): Result<void, "not_found" | "no_such_agent"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const agent = getAgentByName(app.db, username);
  if (!agent) return err("no_such_agent");
  if (deleteCrew(app.db, repo.id, agent.user.id)) {
    app.bus.append({
      kind: "crew.removed",
      repoId: repo.id,
      actorId: admin.value.id,
      payload: { agent: agent.user.username },
    });
  }
  return ok();
}

export { getAgent };
