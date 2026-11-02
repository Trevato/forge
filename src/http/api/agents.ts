/**
 * The forge's crew agents over the API: `GET` and `POST /api/v1/agents`, and
 * `GET`, `PATCH` and `DELETE /api/v1/agents/:username`. Moved out of `api.ts`
 * (#6329); the rules live in `actions/crew.ts`.
 */

import {
  askedRoles,
  createAgent,
  deleteAgent,
  getAgentView,
  listAllAgents,
  updateAgent,
} from "../../actions/crew.ts";
import type { Agent } from "../../core/agents.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { User } from "../../core/users.ts";
import { agentJson } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, requireAccount, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function agentRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/agents", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const agents = timePhase(ctx.request, "agents", () => listAllAgents(ctx.app, ctx.auth.user));
    if (!agents.ok) return respondAccess(agents.error, 401);
    return timePhase(ctx.request, "render", () =>
      json({
        items: agents.value.map((a) => agentFor(a, ctx.auth.user)),
        next_cursor: null,
      }));
  });

  router.add("POST", "/api/v1/agents", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const made = await createAgent(ctx.app, ctx.auth.user, {
      username: str(input.username),
      ...(typeof input.displayName === "string"
        ? { displayName: input.displayName }
        : {}),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.brief === "string" ? { brief: input.brief } : {}),
      ...(typeof input.budgetUsd === "number"
        ? { budgetUsd: input.budgetUsd }
        : {}),
      ...askedRoles(input.roles),
    });
    if (!made.ok) return respondAccess(made.error, 422);
    return json(agentJson(made.value), 201);
  });

  router.add("GET", "/api/v1/agents/:username", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const agent = timePhase(ctx.request, "agent", () =>
      getAgentView(ctx.app, ctx.auth.user, ctx.params.username ?? ""),
    );
    if (!agent.ok) return respondAccess(agent.error, 404);
    const view = agent.value;
    return timePhase(ctx.request, "render", () =>
      json(agentFor(view, ctx.auth.user)),
    );
  });

  router.add("PATCH", "/api/v1/agents/:username", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const updated = updateAgent(
      ctx.app,
      ctx.auth.user,
      ctx.params.username ?? "",
      {
        ...(typeof input.model === "string" ? { model: input.model } : {}),
        ...(typeof input.brief === "string" ? { brief: input.brief } : {}),
        ...(typeof input.budgetUsd === "number"
          ? { budgetUsd: input.budgetUsd }
          : {}),
        ...askedRoles(input.roles),
      },
    );
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(agentJson(updated.value));
  });

  router.add("DELETE", "/api/v1/agents/:username", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const removed = deleteAgent(
      ctx.app,
      ctx.auth.user,
      ctx.params.username ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 404);
    return json({}, 200);
  });
}

/**
 * An agent as `viewer` may see it: its brief, model and budget are the
 * owner's configuration (#946), for the forge's owner and the agent itself;
 * anyone else signed in sees who it is.
 */
export function agentFor(agent: Agent, viewer: User | undefined) {
  if (viewer?.isAdmin === true || viewer?.id === agent.user.id)
    return agentJson(agent);
  return {
    username: agent.user.username,
    displayName: agent.user.displayName,
    createdAt: agent.createdAt,
  };
}
