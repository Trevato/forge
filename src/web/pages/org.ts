/**
 * Owner pages: the profile at `/:owner`, which serves a person and an org
 * from one template, and — for orgs — the team surfaces an admin runs the
 * place from. An org's access model *is* its teams, so this is where they are
 * edited.
 *
 * Every mutation here goes through `src/actions/orgs.ts` and comes back as a
 * redirect carrying a flash, so a silent failure is impossible: adding an
 * unknown username now says so.
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
import { listReposByOwner, type Repo } from "../../core/repos.ts";
import { getUserByName, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page } from "../layout.ts";
import {
  avatar,
  badge,
  btn,
  card,
  confirmAction,
  empty,
  listCard,
  pager,
  pill,
  row,
  selectField,
  time,
  field as uiField,
} from "../ui.ts";

const PER_PAGE = 20;

// ---- profile ----

/** The repo list, filtered by the box above it and paged by repo id. */
function repoSection(ctx: Ctx, owner: User, isSelf: boolean): Html {
  const query = (ctx.url.searchParams.get("q") ?? "").slice(0, 100);
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  const repos = listReposByOwner(ctx.app.db, owner.username, ctx.auth.user, {
    limit: PER_PAGE + 1,
    ...(query !== "" ? { query } : {}),
    ...(cursor !== "" ? { cursor } : {}),
  });
  const shown = repos.slice(0, PER_PAGE);
  const last = shown[shown.length - 1];
  const nextParams = new URLSearchParams();
  if (query !== "") nextParams.set("q", query);
  if (last) nextParams.set("cursor", last.id);

  const lead = (repo: Repo) =>
    icon(repo.forkParentId !== null ? "fork" : "repo");

  return html`<div class="filters">
      <form method="get" action="/${owner.username}" role="search">
        <input
          class="input search"
          type="search"
          name="q"
          value="${query}"
          placeholder="Find a repository"
          aria-label="Find a repository"
          data-search-input
        />
        <button class="btn" data-size="sm" type="submit">Filter</button>
      </form>
    </div>
    ${shown.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No repositories yet" : "No matches",
          note:
            query === ""
              ? `${owner.username} has not published anything you can see.`
              : "Try a different search.",
          ...(isSelf && query === ""
            ? {
                action: btn("New repository", {
                  href: `/new?owner=${owner.username}`,
                  variant: "primary",
                }),
              }
            : {}),
        })
      : listCard(
          shown.map((repo) =>
            row({
              href: `/${repo.ownerName}/${repo.name}`,
              lead: lead(repo),
              title: repo.name,
              nav: true,
              ...(repo.description !== ""
                ? { meta: html`${repo.description}` }
                : {}),
              trail:
                repo.visibility === "private"
                  ? badge("Private", { icon: "lock", variant: "secondary" })
                  : badge("Public", { variant: "secondary" }),
            }),
          ),
        )}
    ${pager(
      repos.length > PER_PAGE && last
        ? { next: `/${owner.username}?${nextParams.toString()}` }
        : {},
    )}`;
}

/** Everyone on any of the org's teams, once each. */
function orgMembers(ctx: Ctx, teams: Team[]): User[] {
  const seen = new Map<string, User>();
  for (const team of teams)
    for (const member of listTeamMembers(ctx.app.db, team.id))
      if (!seen.has(member.id)) seen.set(member.id, member);
  return [...seen.values()].sort((a, b) =>
    a.username.localeCompare(b.username),
  );
}

function teamsSection(ctx: Ctx, org: User, canManage: boolean): Html {
  const teams = listTeams(ctx.app.db, org.id);
  const members = orgMembers(ctx, teams);
  return html`<h2 class="mt">Members</h2>
    ${members.length === 0
      ? empty({ icon: "users", title: "No members yet" })
      : listCard(
          members.map((m) =>
            row({
              href: `/${m.username}`,
              lead: avatar(m.username),
              title: m.displayName || m.username,
              nav: true,
              ...(m.displayName ? { meta: html`@${m.username}` } : {}),
            }),
          ),
        )}

    <h2 class="mt">Teams</h2>
    ${listCard(
      teams.map((t) =>
        row({
          lead: icon("users"),
          title: t.name,
          meta: html`${pill(listTeamMembers(ctx.app.db, t.id).length)}
          ${listTeamMembers(ctx.app.db, t.id).length === 1
            ? "member"
            : "members"}`,
          trail: html`${badge(t.permission)}${when(canManage, () =>
            btn("Manage", {
              href: `/${org.username}/-/teams/${t.id}`,
              size: "sm",
            }),
          )}`,
        }),
      ),
    )}
    ${when(canManage, () =>
      card(
        html`<form method="post" action="/${org.username}/-/teams">
          ${uiField({
            label: "Team name",
            name: "name",
            required: true,
            hint: "Teams grant their permission on every repository the org owns.",
          })}
          ${selectField({
            label: "Permission",
            name: "permission",
            options: [
              { value: "read", label: "read — clone and browse" },
              { value: "write", label: "write — push, merge, triage" },
              { value: "admin", label: "admin — settings and teams" },
            ],
          })}
          <div class="form-actions">
            ${btn("Create team", { variant: "primary" })}
          </div>
        </form>`,
        { head: html`<h3>New team</h3>` },
      ),
    )}`;
}

// GET /:owner — a person or an org, with their repos.
export function ownerProfile(ctx: Ctx): Response {
  const owner = getUserByName(ctx.app.db, ctx.params.owner ?? "");
  if (!owner) return notFoundPage(ctx);

  const isOrg = owner.kind === "org";
  const access = isOrg
    ? orgAccess(ctx.app.db, owner.id, ctx.auth.user)
    : "none";
  const canManage = isOrg && accessAllows(access, "admin");
  const isSelf =
    ctx.auth.user !== undefined && (ctx.auth.user.id === owner.id || canManage);

  const body = html`<div class="page-head">
      ${avatar(owner.username, "lg")}
      <div class="grow">
        <h1>${owner.displayName || owner.username}</h1>
        <p class="muted small">
          ${badge(isOrg ? "organization" : "user")} @${owner.username} · joined
          ${time(owner.createdAt)}
        </p>
      </div>
      ${when(isSelf, () =>
        btn("New repository", {
          href: `/new?owner=${owner.username}`,
          variant: "primary",
          size: "sm",
          icon: "plus",
        }),
      )}
    </div>
    ${repoSection(ctx, owner, isSelf)}
    ${when(isOrg && accessAllows(access, "read"), () =>
      teamsSection(ctx, owner, canManage),
    )}`;

  return page({ ctx, title: owner.username, body });
}

// ---- creating an org ----

function orgForm(ctx: Ctx, value: string, error?: string): Response {
  return page(
    {
      ctx,
      title: "New organization",
      body: html`<div class="narrow">
        ${pageHead("New organization")}
        <p class="muted small mb">
          An organization owns repositories and hands out access through teams.
          You become its first owner.
        </p>
        <form method="post" action="/organizations/new">
          ${uiField({
            label: "Organization name",
            name: "name",
            value,
            required: true,
            autofocus: true,
            pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
            hint: "Letters, digits, dots, dashes. This becomes the URL.",
            ...(error ? { error } : {}),
          })}
          <div class="form-actions">
            ${btn("Create organization", { variant: "primary" })}
            ${btn("Cancel", { href: "/", variant: "ghost" })}
          </div>
        </form>
      </div>`,
    },
    error ? 422 : 200,
  );
}

// GET /organizations/new
export function newOrgPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return orgForm(ctx, "");
}

// POST /organizations/new
export async function newOrgSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const name = field(form, "name");
  const created = createOrg(ctx.app, ctx.auth.user, name);
  if (!created.ok) {
    const messages: Record<string, string> = {
      name_taken: "That name is already taken.",
      invalid_name: "Letters, digits, dots and dashes only.",
      unauthorized: "Sign in to create an organization.",
    };
    return orgForm(
      ctx,
      name,
      messages[created.error] ?? "That name won't work.",
    );
  }
  return flashTo(ctx, `/${created.value.username}`, {
    message: `Created ${created.value.username}. You are its first owner.`,
  });
}

// ---- team management (org admins only) ----

/** The org for admin pages. A non-admin gets nothing back, so the whole
 * surface is invisible rather than merely refused. */
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
  if (!org) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const chosen = field(form, "permission");
  const permission: Permission =
    chosen === "write" || chosen === "admin" ? chosen : "read";
  const name = field(form, "name");
  const created = createTeam(ctx.app, ctx.auth.user, org, name, permission);
  if (!created.ok) {
    const messages: Record<string, string> = {
      name_taken: `${org.username} already has a team called ${name}.`,
      invalid_name: "A team needs a name.",
    };
    return flashTo(ctx, `/${org.username}`, {
      tone: "danger",
      message: messages[created.error] ?? "Could not create that team.",
    });
  }
  return flashTo(ctx, `/${org.username}/-/teams/${created.value.id}`, {
    message: `Created ${created.value.name} with ${permission} access.`,
  });
}

// GET /:owner/-/teams/:team
export function teamPage(ctx: Ctx): Response {
  const org = requireOrgAdmin(ctx);
  if (!org) return notFoundPage(ctx);
  const team = getTeam(ctx.app.db, ctx.params.team ?? "");
  if (!team || team.orgId !== org.id) return notFoundPage(ctx);

  const members = listTeamMembers(ctx.app.db, team.id);
  const teamBase = `/${org.username}/-/teams/${team.id}`;
  // The last owner may not be removed: an org must keep an admin.
  const protectedTeam = team.name === OWNERS_TEAM;

  const body = html`${pageHead(team.name, {
    lead: icon("users"),
    sub: html`${badge(team.permission)} on every repository ${org.username} owns`,
  })}
  ${members.length === 0
    ? empty({ icon: "users", title: "Nobody on this team yet" })
    : listCard(
        members.map((m) =>
          row({
            lead: avatar(m.username),
            title: html`<a href="/${m.username}"
              >${m.displayName || m.username}</a
            >`,
            meta: html`@${m.username}`,
            trail: when(
              !protectedTeam || members.length > 1,
              () =>
                html`<form method="post" action="${teamBase}/remove">
                  <input type="hidden" name="user" value="${m.username}" />
                  ${btn("Remove", { variant: "danger", size: "sm" })}
                </form>`,
            ),
          }),
        ),
      )}
  ${card(
    html`<form method="post" action="${teamBase}/add">
      ${uiField({
        label: "Add a member",
        name: "user",
        required: true,
        hint: "Their username on this forge.",
      })}
      <div class="form-actions">
        ${btn("Add member", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h3>Membership</h3>` },
  )}
  ${when(!protectedTeam, () =>
    card(
      html`<p class="muted small mb">
          Deleting ${team.name} revokes its ${team.permission} access for
          ${members.length} ${members.length === 1 ? "person" : "people"}.
          Repositories are untouched.
        </p>
        ${confirmAction({
          action: `${teamBase}/delete`,
          verb: "Delete team",
        })}`,
      { head: html`<h3>Danger zone</h3>`, tone: "danger" },
    ),
  )}`;

  return page({
    ctx,
    title: `${team.name} · ${org.username}`,
    crumbs: [
      { label: org.username, href: `/${org.username}` },
      { label: team.name, href: teamBase },
    ],
    body,
  });
}

/** The three team POSTs share a resolution: org, team, and a checked form. */
async function teamAction(
  ctx: Ctx,
): Promise<{ org: User; team: Team; form: Form } | Response> {
  const org = requireOrgAdmin(ctx);
  if (!org) return notFoundPage(ctx);
  const team = getTeam(ctx.app.db, ctx.params.team ?? "");
  if (!team || team.orgId !== org.id) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  return { org, team, form };
}

// POST /:owner/-/teams/:team/add
export async function teamMemberAdd(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  const username = field(r.form, "user").trim();
  const dest = `/${r.org.username}/-/teams/${r.team.id}`;
  const added = addTeamMember(ctx.app, ctx.auth.user, r.org, r.team, username);
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        added.error === "no_such_user"
          ? `No account called ${username || "that"}.`
          : "Could not add that member.",
    });
  return flashTo(ctx, dest, {
    message: added.value.added
      ? `Added ${username} to ${r.team.name}.`
      : `${username} was already on ${r.team.name}.`,
  });
}

// POST /:owner/-/teams/:team/remove
export async function teamMemberRemove(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  const username = field(r.form, "user").trim();
  const dest = `/${r.org.username}/-/teams/${r.team.id}`;
  const removed = removeTeamMember(
    ctx.app,
    ctx.auth.user,
    r.org,
    r.team,
    username,
  );
  if (!removed.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        removed.error === "no_such_user"
          ? `No account called ${username || "that"}.`
          : "Could not remove that member.",
    });
  return flashTo(ctx, dest, {
    message: removed.value.removed
      ? `Removed ${username} from ${r.team.name}.`
      : `${r.team.name} must keep at least one owner.`,
    ...(removed.value.removed ? {} : { tone: "danger" as const }),
  });
}

// POST /:owner/-/teams/:team/delete
export async function teamDelete(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  const deleted = deleteTeam(ctx.app, ctx.auth.user, r.org, r.team);
  if (!deleted.ok)
    return flashTo(ctx, `/${r.org.username}/-/teams/${r.team.id}`, {
      tone: "danger",
      message: `${r.team.name} is protected — an organization must keep its owners.`,
    });
  return flashTo(ctx, `/${r.org.username}`, {
    message: `Deleted the ${r.team.name} team.`,
  });
}
