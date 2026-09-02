/**
 * Owner pages: a profile at /:owner that lists repos (works for a person or an
 * org), and — for orgs — team management for admins. Orgs are created here too.
 * An org's access model is teams; this is the surface that edits them.
 */

import {
  addTeamMember,
  createOrg,
  createTeam,
  deleteTeam,
  removeTeamMember,
} from "../../actions/orgs.ts";
import {
  OWNERS_TEAM,
  accessAllows,
  getOrg,
  getTeam,
  listTeamMembers,
  listTeams,
  orgAccess,
  type Permission,
  type Team,
} from "../../core/orgs.ts";
import { listReposByOwner } from "../../core/repos.ts";
import { getUserByName, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";

// GET /:owner — a person or org profile with their repos.
export function ownerProfile(ctx: Ctx): Response {
  const name = ctx.params.owner ?? "";
  const owner = getUserByName(ctx.app.db, name);
  if (!owner) {
    return page(
      {
        title: "Not found",
        user: ctx.auth.user,
        theme: ctx.theme,
        body: html`<div class="empty"><h1>404</h1></div>`,
      },
      404,
    );
  }
  const repos = listReposByOwner(ctx.app.db, owner.username, ctx.auth.user);
  const isOrg = owner.kind === "org";
  const access = isOrg
    ? orgAccess(ctx.app.db, owner.id, ctx.auth.user)
    : "none";
  const canManage = isOrg && accessAllows(access, "admin");

  const body = html`<div class="page-head">
      <h1>${owner.username}</h1>
      <span class="badge">${isOrg ? "organization" : "user"}</span>
      <span class="spacer"></span>
      ${when(
        ctx.auth.user !== undefined &&
          (ctx.auth.user.id === owner.id || canManage),
        () =>
          html`<a class="btn" data-size="sm" href="/new?owner=${owner.username}"
            >New repository</a
          >`,
      )}
    </div>
    ${repos.length === 0
      ? html`<div class="card empty">No repositories.</div>`
      : html`<div class="card">
          <ul class="list">
            ${repos.map(
              (r) =>
                html`<li>
                  <a class="row" href="/${r.ownerName}/${r.name}">
                    <span class="grow"><strong>${r.name}</strong></span>
                    <span class="badge">${r.visibility}</span>
                  </a>
                </li>`,
            )}
          </ul>
        </div>`}
    ${when(isOrg && accessAllows(access, "read"), () =>
      teamsSection(ctx, owner.id, owner.username, canManage),
    )}`;
  return page({
    title: owner.username,
    user: ctx.auth.user,
    theme: ctx.theme,
    body,
  });
}

function teamsSection(
  ctx: Ctx,
  orgId: string,
  orgName: string,
  canManage: boolean,
): Html {
  const teams = listTeams(ctx.app.db, orgId);
  return html`<h2 class="mt">Teams</h2>
    <div class="card">
      <ul class="list">
        ${teams.map((t) => {
          const members = listTeamMembers(ctx.app.db, t.id);
          return html`<li>
            <div class="row">
              <span class="grow">
                <strong>${t.name}</strong>
                <span class="badge">${t.permission}</span>
                <br />
                <span class="muted small"
                  >${members.map((m) => m.username).join(", ") ||
                  "no members"}</span
                >
              </span>
              ${when(
                canManage,
                () =>
                  html`<a
                    class="btn"
                    data-size="sm"
                    href="/${orgName}/-/teams/${t.id}"
                    >Manage</a
                  >`,
              )}
            </div>
          </li>`;
        })}
      </ul>
    </div>
    ${when(
      canManage,
      () =>
        html`<form
          class="card settings-card hook-new"
          method="post"
          action="/${orgName}/-/teams"
        >
          <input class="input" name="name" placeholder="Team name" required />
          <select class="input" name="permission">
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="admin">admin</option>
          </select>
          <button class="btn" type="submit">Create team</button>
        </form>`,
    )}`;
}

// GET /organizations/new
export function newOrgPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return redirect("/signin");
  const body = html`<div class="narrow">
    <h1>New organization</h1>
    <form method="post" action="/organizations/new">
      <label for="name">Organization name</label>
      <input
        class="input"
        id="name"
        name="name"
        required
        autofocus
        pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
      />
      <div class="form-actions">
        <button class="btn" data-variant="primary" type="submit">
          Create organization
        </button>
      </div>
    </form>
  </div>`;
  return page({
    title: "New organization",
    user: ctx.auth.user,
    theme: ctx.theme,
    body,
  });
}

// POST /organizations/new
export async function newOrgSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const created = createOrg(ctx.app, ctx.auth.user, field(form, "name"));
  if (!created.ok) {
    const msg =
      created.error === "name_taken" ? "That name is taken." : "Invalid name.";
    return page({
      title: "New organization",
      user: ctx.auth.user,
      theme: ctx.theme,
      body: html`<div class="narrow">
        <h1>New organization</h1>
        <p class="error-note">${msg}</p>
        <a class="btn" href="/organizations/new">Back</a>
      </div>`,
    });
  }
  return redirect(`/${created.value.username}`);
}

// ---- team management (org admins only) ----

/** The org for admin pages: resolved here, gated by every action (and by the
 * page itself, so the team pages are invisible to non-admins). */
function requireOrgAdmin(ctx: Ctx): User | undefined {
  const org = getOrg(ctx.app.db, ctx.params.owner ?? "");
  if (!org) return undefined;
  if (!accessAllows(orgAccess(ctx.app.db, org.id, ctx.auth.user), "admin"))
    return undefined;
  return org;
}

// POST /:owner/-/teams
export async function teamCreate(ctx: Ctx): Promise<Response> {
  const org = requireOrgAdmin(ctx);
  if (!org)
    return page(
      {
        title: "Not found",
        user: ctx.auth.user,
        theme: ctx.theme,
        body: html`<div class="empty"><h1>404</h1></div>`,
      },
      404,
    );
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const perm = field(form, "permission");
  const permission: Permission =
    perm === "write" || perm === "admin" ? perm : "read";
  createTeam(ctx.app, ctx.auth.user, org, field(form, "name"), permission);
  return redirect(`/${org.username}`);
}

// GET /:owner/-/teams/:team
export function teamPage(ctx: Ctx): Response {
  const org = requireOrgAdmin(ctx);
  if (!org)
    return page(
      {
        title: "Not found",
        user: ctx.auth.user,
        theme: ctx.theme,
        body: html`<div class="empty"><h1>404</h1></div>`,
      },
      404,
    );
  const team = getTeam(ctx.app.db, ctx.params.team ?? "");
  if (!team || team.orgId !== org.id) {
    return page(
      {
        title: "Not found",
        user: ctx.auth.user,
        theme: ctx.theme,
        body: html`<div class="empty"><h1>404</h1></div>`,
      },
      404,
    );
  }
  const members = listTeamMembers(ctx.app.db, team.id);
  const teamBase = `/${org.username}/-/teams/${team.id}`;
  const body = html`<div class="page-head">
      <h1>${org.username} / ${team.name}</h1>
      <span class="badge">${team.permission}</span>
    </div>
    <div class="card">
      <ul class="list">
        ${members.map(
          (m) =>
            html`<li>
              <div class="row">
                <span class="grow">${m.username}</span>
                ${when(
                  team.name !== OWNERS_TEAM || members.length > 1,
                  () =>
                    html`<form
                      method="post"
                      action="${teamBase}/remove"
                      class="inline"
                    >
                      <input type="hidden" name="user" value="${m.username}" />
                      <button
                        class="btn"
                        data-size="sm"
                        data-variant="danger"
                        type="submit"
                      >
                        Remove
                      </button>
                    </form>`,
                )}
              </div>
            </li>`,
        )}
      </ul>
    </div>
    <form
      class="card settings-card hook-new"
      method="post"
      action="${teamBase}/add"
    >
      <input class="input" name="user" placeholder="Username to add" required />
      <button class="btn" type="submit">Add member</button>
    </form>
    ${when(
      team.name !== OWNERS_TEAM,
      () =>
        html`<form method="post" action="${teamBase}/delete" class="mt">
          <button class="btn" data-variant="danger" type="submit">
            Delete team
          </button>
        </form>`,
    )}`;
  return page({
    title: `${team.name} · ${org.username}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    body,
  });
}

async function teamAction(
  ctx: Ctx,
): Promise<{ org: User; team: Team; form: Form } | Response> {
  const org = requireOrgAdmin(ctx);
  if (!org) return new Response("not found", { status: 404 });
  const team = getTeam(ctx.app.db, ctx.params.team ?? "");
  if (!team || team.orgId !== org.id)
    return new Response("not found", { status: 404 });
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  return { org, team, form };
}

// POST /:owner/-/teams/:team/add
export async function teamMemberAdd(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  addTeamMember(ctx.app, ctx.auth.user, r.org, r.team, field(r.form, "user"));
  return redirect(`/${r.org.username}/-/teams/${r.team.id}`);
}

// POST /:owner/-/teams/:team/remove
export async function teamMemberRemove(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  removeTeamMember(
    ctx.app,
    ctx.auth.user,
    r.org,
    r.team,
    field(r.form, "user"),
  );
  return redirect(`/${r.org.username}/-/teams/${r.team.id}`);
}

// POST /:owner/-/teams/:team/delete
export async function teamDelete(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  deleteTeam(ctx.app, ctx.auth.user, r.org, r.team);
  return redirect(`/${r.org.username}`);
}
