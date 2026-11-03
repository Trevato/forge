/**
 * Organizations and their teams over the API: `POST /api/v1/orgs`,
 * `GET /api/v1/orgs/:org`, and the `…/teams` and `…/teams/:team/members`
 * routes. Moved out of `api.ts` (#6327); the rules live in `actions/orgs.ts`.
 */

import {
  addTeamMember,
  createOrg,
  createTeam,
  deleteTeam,
  removeTeamMember,
} from "../../actions/orgs.ts";
import {
  getOrg,
  listTeamMembers,
  listTeams,
  listTeamsVisibleTo,
  type Permission,
  type Team,
} from "../../core/orgs.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { User } from "../../core/users.ts";
import { keyedPage, keyedWindow } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import {
  apiError,
  body,
  json,
  notFound,
  publicProfile,
  requireScope,
  respondAccess,
  str,
} from "../respond.ts";
import type { Router } from "../router.ts";
import { holds, weakEtag } from "../etag.ts";

/** An org by name plus the team a route names (by name, case-insensitive). */
function loadTeam(ctx: Ctx): { org: User; team: Team } | { error: Response } {
  const org = getOrg(ctx.app.db, ctx.params.org!);
  if (!org) return { error: notFound() };
  const wanted = (ctx.params.team ?? "").toLowerCase();
  const team = listTeams(ctx.app.db, org.id).find(
    (t) => t.name.toLowerCase() === wanted,
  );
  return team ? { org, team } : { error: notFound() };
}

/** Whether the viewer may see this team at all (admin, or a member of it). */
function teamVisible(ctx: Ctx, org: User, team: Team): boolean {
  return listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user).some(
    (t) => t.id === team.id,
  );
}

/**
 * A reader-scoped JSON answer tagged by its exact bytes: a repeat holding the
 * tag gets 304. Callers check access first, so a 304 confirms nothing to
 * someone who may not read it.
 */
function tagged(request: Request, data: unknown): Response {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

const permissionOf = (raw: unknown): Permission => {
  const p = str(raw);
  return p === "write" || p === "admin" ? p : "read";
};

export function orgRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/orgs", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const created = createOrg(ctx.app, ctx.auth.user, str(input.name));
    if (!created.ok) return respondAccess(created.error, 422);
    return json(
      { id: created.value.id, username: created.value.username, kind: "org" },
      201,
    );
  });

  router.add("GET", "/api/v1/orgs/:org", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    const teams = timePhase(ctx.request, "org", () =>
      listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user),
    );
    return timePhase(ctx.request, "render", () =>
      json({ id: org.id, ...publicProfile(org), teams }),
    );
  });

  router.add("GET", "/api/v1/orgs/:org/teams", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const teams = timePhase(ctx.request, "teams", () =>
      listTeamsVisibleTo(ctx.app.db, org.id, ctx.auth.user),
    );
    return timePhase(ctx.request, "render", () =>
      tagged(ctx.request, keyedPage(teams, (t) => t.name, window)),
    );
  });

  router.add("POST", "/api/v1/orgs/:org/teams", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const org = getOrg(ctx.app.db, ctx.params.org!);
    if (!org) return notFound();
    const input = await body(ctx.request);
    const team = createTeam(
      ctx.app,
      ctx.auth.user,
      org,
      str(input.name),
      permissionOf(input.permission),
    );
    if (!team.ok) return respondAccess(team.error, 422);
    return json(team.value, 201);
  });

  router.add("DELETE", "/api/v1/orgs/:org/teams/:team", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    const removed = deleteTeam(ctx.app, ctx.auth.user, found.org, found.team);
    if (!removed.ok) return respondAccess(removed.error, 409);
    return new Response(null, { status: 204 });
  });

  router.add("GET", "/api/v1/orgs/:org/teams/:team/members", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    if (!teamVisible(ctx, found.org, found.team)) return notFound();
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const members = timePhase(ctx.request, "members", () =>
      listTeamMembers(ctx.app.db, found.team.id).map(publicProfile),
    );
    return timePhase(ctx.request, "render", () =>
      tagged(ctx.request, keyedPage(members, (u) => u.username, window)),
    );
  });

  router.add("POST", "/api/v1/orgs/:org/teams/:team/members", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const found = loadTeam(ctx);
    if ("error" in found) return found.error;
    const input = await body(ctx.request);
    const added = addTeamMember(
      ctx.app,
      ctx.auth.user,
      found.org,
      found.team,
      str(input.user),
    );
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, added.value.added ? 201 : 200);
  });

  router.add(
    "DELETE",
    "/api/v1/orgs/:org/teams/:team/members/:username",
    (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const found = loadTeam(ctx);
      if ("error" in found) return found.error;
      const username = ctx.params.username!;
      const isMember = listTeamMembers(ctx.app.db, found.team.id).some(
        (m) => m.username.toLowerCase() === username.toLowerCase(),
      );
      const removed = removeTeamMember(
        ctx.app,
        ctx.auth.user,
        found.org,
        found.team,
        username,
      );
      if (!removed.ok)
        return removed.error === "last_owner"
          ? apiError(
              "last_owner",
              409,
              "an organization keeps at least one person who owns it; make someone else an owner first",
            )
          : respondAccess(removed.error, 422);
      if (!isMember) return notFound();
      return new Response(null, { status: 204 });
    },
  );}
