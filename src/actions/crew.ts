/**
 * Crew actions: create, change and retire agents (a forge admin's job — an
 * agent is an account that acts), and put agents on or take them off a
 * repository's crew (a repository admin's job). Every agent is a user, so
 * everything else about it — its pulls, its comments, its tokens — is
 * handled where users are.
 */

import type { App } from "../app.ts";
import {
  addCrew as insertCrew,
  createAgentRow,
  deleteAgent as removeAgent,
  getAgent,
  getAgentByName,
  listAgents,
  listCrew as queryCrew,
  listCrewRoles,
  removeCrew as deleteCrew,
  updateAgent as patchAgent,
  type Agent,
  type AgentPatch,
  BRIEF_MAX,
  BUDGET_MAX_USD,
  MODEL_MAX,
} from "../core/agents.ts";
import type { Issue, TitleError } from "../core/issues.ts";
import { listRuns } from "../core/runs.ts";
import type { Repo } from "../core/repos.ts";
import { createUser, type CreateUserError, type User } from "../core/users.ts";
import { routeIssue, type Routed } from "../crew/route.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireReader, requireRepoAdmin, requireUser } from "./access.ts";
import { assignIssue, openIssue, type MirrorError } from "./issues.ts";

export interface CreateAgentInput {
  username: string;
  /** @default the username */
  displayName?: string;
  model?: string;
  brief?: string;
  budgetUsd?: number;
}

export type CreateAgentError =
  | "unauthorized"
  | "forbidden"
  | CreateUserError
  | "invalid_model"
  | "brief_too_long"
  | "invalid_budget";

function requireForgeAdmin(
  actor: User | undefined,
): Result<User, "unauthorized" | "forbidden"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  return user.value.isAdmin ? user : err("forbidden");
}

function checkPatch(
  patch: AgentPatch,
): Result<AgentPatch, "invalid_model" | "brief_too_long" | "invalid_budget"> {
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
      patch.budgetUsd > BUDGET_MAX_USD)
  )
    return err("invalid_budget");
  return ok(patch);
}

/** A new crew member. Admin only: this is an account that will act. */
export async function createAgent(
  app: App,
  actor: User | undefined,
  input: CreateAgentInput,
): Promise<Result<Agent, CreateAgentError>> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const patch = checkPatch({
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
  });
  if (!patch.ok) return patch;
  const user = await createUser(app.db, {
    username: input.username,
    email: `${input.username.toLowerCase()}@agents.invalid`,
    password: "",
    displayName: input.displayName ?? input.username,
    agent: true,
  });
  if (!user.ok) return user;
  const agent = createAgentRow(app.db, {
    userId: user.value.id,
    model: patch.value.model,
    brief: patch.value.brief,
    budgetUsd: patch.value.budgetUsd,
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
  patch: AgentPatch,
): Result<Agent, CreateAgentError | "not_found"> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const agent = getAgentByName(app.db, username);
  if (!agent) return err("not_found");
  const checked = checkPatch(patch);
  if (!checked.ok) return checked;
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

/** Put an agent on the crew: it may now read and write this repository. */
export function addToCrew(
  app: App,
  actor: User | undefined,
  repo: Repo,
  username: string,
): Result<Agent, "not_found" | "no_such_agent"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const agent = getAgentByName(app.db, username);
  if (!agent) return err("no_such_agent");
  if (insertCrew(app.db, repo.id, agent.user.id, admin.value.id)) {
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

export interface TellCrewResult {
  readonly issue: Issue;
  /** Who took it, when somebody on the crew builds here. */
  readonly routed: Routed | undefined;
}

/**
 * A sentence becomes work: open it as an issue, and hand it to whichever
 * builder on the crew `routeIssue` picks. The one call behind the web's
 * "Tell the crew" box and the terminal's — a repository with nobody on its
 * crew still opens the issue, just with nobody to route it to.
 */
export async function tellCrew(
  app: App,
  actor: User | undefined,
  repo: Repo,
  text: string,
): Promise<
  Result<TellCrewResult, "not_found" | "unauthorized" | TitleError | "body_too_long" | MirrorError>
> {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\n/)[0]!.trim();
  const title =
    firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
  const opened = openIssue(app, actor, repo, {
    title,
    body: trimmed === firstLine ? "" : trimmed,
  });
  if (!opened.ok) return opened;
  const crew = listCrewRoles(app.db, repo.id);
  const inFlight = new Map<string, number>();
  for (const r of listRuns(app.db, repo.id, { kind: "agent", limit: 50 }))
    if ((r.state === "running" || r.state === "queued") && r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const routed = await routeIssue(app, repo, opened.value, crew, inFlight);
  if (routed === undefined) return ok({ issue: opened.value, routed: undefined });
  assignIssue(app, actor, repo, opened.value, routed.builder.user);
  return ok({ issue: opened.value, routed });
}

export { getAgent };
