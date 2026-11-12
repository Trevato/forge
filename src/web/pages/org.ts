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
  createOrgWords,
  createTeam,
  deleteTeam,
  removeTeamMember,
} from "../../actions/orgs.ts";
import {
  addRefusal,
  addedSays,
  createRefusal,
  createdSays,
  deleteRefusal,
  deletedSays,
  removeRefusal,
  removedSays,
} from "../../actions/team_words.ts";
import {
  OWNERS_TEAM,
  accessAllows,
  getOrg,
  getTeam,
  listTeamMemberRoles,
  listTeamMembers,
  listTeams,
  orgAccess,
  personOwners,
  type Permission,
  type Team,
} from "../../core/orgs.ts";
import { appsForRepos } from "../../core/apps.ts";
import { isTeamRole, TEAM_ROLES } from "../../core/agents.ts";
import { metricsRows, teamWindows } from "../../core/team-metrics.ts";
import { LIST_LIMIT_MAX } from "../../core/issues.ts";
import { listReposByOwner, type Repo } from "../../core/repos.ts";
import { getUserByName, hiddenFrom, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { nameFrame, notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { readOnlyWork } from "../../origins/read-only-work.ts";
import { notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { ownerLine } from "../describe.ts";
import { flashTo, page } from "../layout.ts";
import { secretsSection } from "./secrets.ts";
import { agentsOnForge, grantsSection, saveGrants } from "./subscriptions.ts";
import { shelfRows } from "../studio/shelf.ts";
import {
  avatar,
  badge,
  btn,
  confirmAction,
  dot,
  pager,
  repoCounts,
  row,
  selectField,
  time,
  field as uiField,
} from "../ui.ts";

const PER_PAGE = 20;

/** Rows as a plain list under a heading: the page's lists are sections, never boxes. */
function plainList(rows: Html[]): Html {
  return html`<ul class="list setting-list">
    ${rows}
  </ul>`;
}

/** An empty state as one muted line (a title, and a note when there is one). */
function nothing(title: string, note?: string, action?: Html): Html {
  return html`<p class="muted">${title}${note ? html`. ${note}` : null}</p>
    ${action ? html`<p class="form-actions">${action}</p>` : null}`;
}

// ---- profile ----

/**
 * The repo list, filtered by the box above it and paged by repo id. Apps
 * are drawn once, by `appsSection` above — so this list omits
 * whatever page of results already showed there, and says so when that
 * leaves it with nothing: "no other repositories" reads as the true state
 * of the world, not as a bug. Pagination still walks the raw, unfiltered
 * rows (the cursor is a repo id), so leaving apps out of what is *shown*
 * never skips or repeats a plain repository across pages.
 */
function repoSection(
  ctx: Ctx,
  owner: User,
  isSelf: boolean,
  anyApps: boolean,
): Html {
  const query = (ctx.url.searchParams.get("q") ?? "").slice(0, 100);
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  const repos = listReposByOwner(ctx.app.db, owner.username, ctx.auth.user, {
    limit: PER_PAGE + 1,
    ...(query !== "" ? { query } : {}),
    ...(cursor !== "" ? { cursor } : {}),
  });
  const page = repos.slice(0, PER_PAGE);
  const last = page[page.length - 1];
  const nextParams = new URLSearchParams();
  if (query !== "") nextParams.set("q", query);
  if (last) nextParams.set("cursor", last.id);

  const apps = appsForRepos(
    ctx.app.db,
    page.map((r) => r.id),
  );
  // The owner's read-only mirrors are drawn once, in "work (read-only)".
  const mirrored = new Set(
    isSelf ? readOnlyWork(ctx.app.db, owner.id).flatMap((o) => o.repos.map((r) => r.name)) : [],
  );
  const shown = page.filter((repo) => !apps.has(repo.id) && !mirrored.has(repo.name));

  const lead = (repo: Repo) =>
    icon(repo.forkParentId !== null ? "fork" : "repo");

  return html`<div class="bar mt mb">
      <form class="bar" method="get" action="/${owner.username}" role="search">
        <input
          class="input"
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
      ? nothing(
          query !== ""
            ? "No matches"
            : anyApps
              ? "No other repositories"
              : "No repositories yet",
          query !== ""
            ? "Try a different search."
            : anyApps
              ? `Every repository ${owner.username} has is already listed as an app above.`
              : `${owner.username} has not published anything you can see.`,
          isSelf && query === ""
            ? btn("New repository", {
                href: `/new?owner=${owner.username}`,
                variant: "primary",
              })
            : undefined,
        )
      : html`<section class="settings-block">
          <h2>${anyApps ? "Other repositories" : "Repositories"}</h2>
          ${plainList(
            shown.map((repo) =>
              row({
                href: `/${repo.ownerName}/${repo.name}`,
                lead: lead(repo),
                title: repo.name,
                nav: true,
                ...(repo.description !== ""
                  ? { meta: html`${repo.description}` }
                  : {}),
                trail: html`${repoCounts({
                  openIssues: repo.counts?.openIssues,
                  openPulls: repo.counts?.openPulls,
                })}${repo.visibility === "private"
                  ? badge("Private", { icon: "lock", variant: "secondary" })
                  : badge("Public", { variant: "secondary" })}`,
              }),
            ),
          )}
        </section>`}
    ${pager(
      repos.length > PER_PAGE && last
        ? { next: `/${owner.username}?${nextParams.toString()}` }
        : {},
    )}`;
}

/**
 * "work (read-only)": what the owner mirrors from origins connected read-only,
 * with its last fetch and, when it failed, why in one line. Only ever drawn
 * for the owner's own view; nothing at all for anyone else.
 */
function workSection(ctx: Ctx, owner: User): Html {
  const origins = readOnlyWork(ctx.app.db, owner.id);
  if (origins.length === 0) return html``;
  return html`<section class="settings-block" id="work-read-only">
    <h2>work (read-only)</h2>
    ${origins.map(
      (o) => html`<p class="small muted">${URL.parse(o.webUrl)?.host ?? o.webUrl}</p>
        ${plainList(
          o.repos.map((r) =>
            row({
              href: `/${owner.username}/${r.name}`,
              lead: icon("repo"),
              title: r.fullName,
              nav: true,
              meta:
                r.problem !== ""
                  ? html`Last fetch failed: ${r.problem}`
                  : r.lastFetchAt === null
                    ? html`Not fetched yet`
                    : html`Last fetch ${time(r.lastFetchAt)}`,
            }),
          ),
        )}`,
    )}
  </section>`;
}

/**
 * The owner's apps, one shelf row each — the same row the home's *Your
 * apps* card draws (`shelfRows`, `studio/shelf.ts`), never a second copy of
 * it. Visibility is `listReposByOwner`'s own, the same rule the repository
 * list below uses, so a stranger never sees a private app here either. An
 * owner with no app a visitor can see shows the visitor nothing here; the
 * owner themselves is offered the first one.
 */
async function appsSection(
  ctx: Ctx,
  owner: User,
  isSelf: boolean,
): Promise<{ html: Html; count: number }> {
  const repos = listReposByOwner(ctx.app.db, owner.username, ctx.auth.user, {
    limit: 200,
  });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  const appRepos = repos.filter((r) => records.has(r.id));
  const newAppHref = `/apps/new?owner=${owner.username}`;

  if (appRepos.length === 0)
    return {
      count: 0,
      html: when(isSelf, () =>
        nothing(
          "No apps yet",
          "Make one, tell the crew what it is, and watch it come up.",
          btn("New app", { href: newAppHref, variant: "primary" }),
        ),
      ),
    };

  const rows = await shelfRows(ctx, appRepos);
  return {
    count: appRepos.length,
    html: html`<section class="settings-block">
      <h2>Apps</h2>
      ${plainList(rows)}
      ${when(isSelf, () =>
        html`<p class="form-actions">${btn("New app", { href: newAppHref, size: "sm", icon: "plus" })}</p>`,
      )}
    </section>`,
  };
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

/** A team's members with the role each holds (#571), one fact each: name, then role. */
function teamMemberFacts(ctx: Ctx, team: Team): { label: string; value: string }[] {
  return listTeamMemberRoles(ctx.app.db, team.id).map(({ user, role }) => ({
    label: user.username,
    value: role,
  }));
}

/** "1 member" / "4 members" — a sentence, not a number in a pill. */
function memberCount(n: number): Html {
  return html`${n} member${n === 1 ? "" : "s"}`;
}

function teamsSection(ctx: Ctx, org: User, canManage: boolean): Html {
  const teams = listTeams(ctx.app.db, org.id);
  const members = orgMembers(ctx, teams);
  return html`<section class="settings-block">
      <h2>Members</h2>
      ${members.length === 0
        ? nothing("No members yet")
        : plainList(
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
    </section>
    <section class="settings-block">
      <h2 id="teams">Teams</h2>
      ${teams.length === 0
        ? nothing("No teams yet")
        : plainList(
        teams.map((t) =>
          row({
            lead: icon("users"),
            title: t.name,
            meta: memberCount(listTeamMembers(ctx.app.db, t.id).length),
            facts: teamMemberFacts(ctx, t),
            trail: html`${badge(t.permission)}${when(canManage, () =>
              btn("Manage", {
                href: `/${org.username}/-/teams/${t.id}`,
                size: "sm",
              }),
            )}`,
          }),
        ),
      )}
    </section>
    ${when(
      canManage,
      () => html`<section class="settings-block">
        <h2>New team</h2>
        <form method="post" action="/${org.username}/-/teams">
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
        </form>
      </section>`,
    )}`;
}

// GET /:owner — a person or an org, for every viewer: their apps first,
// drawn by the same shelf the home draws its *Your apps* card from, then
// their other repositories, then — for an org — its members and teams.
export async function ownerProfile(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const owner = timePhase(ctx.request, "owner", () =>
    getUserByName(ctx.app.db, ctx.params.owner ?? ""),
  );
  if (!owner || hiddenFrom(owner, ctx.auth.user)) return notFoundPage(ctx);

  const isOrg = owner.kind === "org";
  const access = timePhase(ctx.request, "access", () =>
    isOrg ? orgAccess(ctx.app.db, owner.id, ctx.auth.user) : "none",
  );
  const canManage = isOrg && accessAllows(access, "admin");
  const isSelf =
    ctx.auth.user !== undefined && (ctx.auth.user.id === owner.id || canManage);
  const apps = await timePhaseAsync(ctx.request, "apps", () =>
    appsSection(ctx, owner, isSelf),
  );
  const repos = timePhase(ctx.request, "repos", () =>
    repoSection(ctx, owner, isSelf, apps.count > 0),
  );
  const rendering = performance.now();
  // Said to the people it concerns: its members and the forge's owner.
  const ownerless =
    isOrg && access !== "none" && personOwners(ctx.app.db, owner.id).length === 0;

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
          variant: "ghost",
          size: "sm",
          icon: "plus",
        }),
      )}
    </div>
    ${ownerless
      ? html`<p class="small">
          ${dot("attn")} Nobody can administer this organization right now:
          everyone on its Owners team is suspended or removed. What it holds
          stays as it is; the forge's owner can unsuspend an owner or
          <a href="/${owner.username}/-/teams/${OWNERS_TEAM}">add one</a>.
        </p>`
      : null}
    ${apps.html}
    ${repos}
    ${when(ctx.auth.user !== undefined && ctx.auth.user.id === owner.id && !isOrg, () =>
      workSection(ctx, owner),
    )}
    ${when(isOrg && accessAllows(access, "read"), () =>
      teamsSection(ctx, owner, canManage),
    )}
    ${when(
      isOrg && ctx.auth.user?.isAdmin === true,
      () =>
        html`<div class="mt">
          ${grantsSection(ctx, {
            scopeId: owner.id,
            agents: agentsOnForge(ctx),
            action: `/${owner.username}/-/subscriptions`,
            wider: "the forge's own token",
            title: "Subscriptions for every repository here",
          })}
        </div>`,
    )}
    ${when(
      isOrg && ctx.auth.user?.isAdmin === true && ctx.auth.user.kind === "user",
      () =>
        html`<p class="mt small">
          <a href="/settings/accounts/${encodeURIComponent(owner.username)}">Model spend ceilings</a>
        </p>`,
    )}
    ${isOrg ? orgSecrets(ctx, owner.username) : null}`;

  const listed = timePhase(ctx.request, "listed", () =>
    listReposByOwner(ctx.app.db, owner.username, undefined, {
      limit: LIST_LIMIT_MAX,
    }),
  );
  const res = page({
    ctx,
    title: owner.username,
    description: ownerLine({
      org: isOrg,
      name: owner.username,
      publicRepos: listed.length,
      more: listed.length >= LIST_LIMIT_MAX,
    }),
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

function orgSecrets(ctx: Ctx, name: string): Html | null {
  const secrets = secretsSection(ctx, "org", name);
  return secrets ? html`<div class="mt">${secrets}</div>` : null;
}

// POST /:owner/-/subscriptions
export async function orgSubscriptionsSave(ctx: Ctx): Promise<Response> {
  const org = requireOrgAdmin(ctx);
  if (!org || ctx.auth.user?.isAdmin !== true) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  saveGrants(ctx, form, org.id, agentsOnForge(ctx));
  return flashTo(ctx, `/${org.username}`, {
    message:
      "Saved. Every repository here without a grant of its own follows it.",
  });
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
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () =>
    ctx.auth.user ? orgForm(ctx, "") : signInFirst(ctx),
  );
}

// POST /organizations/new
export async function newOrgSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const name = field(form, "name");
  const created = createOrg(ctx.app, ctx.auth.user, name);
  if (!created.ok) return orgForm(ctx, name, createOrgWords(created.error));
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
  if (!created.ok)
    return flashTo(ctx, `/${org.username}`, {
      tone: "danger",
      message: createRefusal(created.error, org.username, name),
    });
  return flashTo(ctx, `/${org.username}/-/teams/${created.value.id}`, {
    message: createdSays(created.value.name, permission),
  });
}

// GET /:owner/-/teams/:team
export function teamPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const org = timePhase(ctx.request, "org", () => requireOrgAdmin(ctx));
  if (!org) return notFoundPage(ctx);
  const team = timePhase(ctx.request, "team", () =>
    getTeam(ctx.app.db, ctx.params.team ?? ""),
  );
  if (!team || team.orgId !== org.id) return notFoundPage(ctx);

  const members = timePhase(ctx.request, "members", () =>
    listTeamMemberRoles(ctx.app.db, team.id).map(({ user, role }) => ({ ...user, role })),
  );
  const figures = timePhase(ctx.request, "metrics", () =>
    teamWindows(ctx.app.db, team.id, Date.now()),
  );
  const rendering = performance.now();
  const teamBase = `/${org.username}/-/teams/${team.id}`;
  // The last owner may not be removed: an org must keep an admin.
  const protectedTeam = team.name === OWNERS_TEAM;

  const body = html`${pageHead(team.name, {
    lead: icon("users"),
    sub: html`${badge(team.permission)} on every repository ${org.username} owns`,
  })}
  <section class="settings-block">
    <h2>How fast this team turns issues into shipped changes, and what each costs</h2>
    ${([
      ["24 h", figures.day],
      ["7 d", figures.week],
    ] as const).map(
      ([label, m]) => html`<h3>${label}</h3>
        <dl class="status-rows">
          ${metricsRows(m).map((r) => html`<div class="status-row"><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}
        </dl>`,
    )}
  </section>
  <section class="settings-block">
    <h2>Members</h2>
    ${members.length === 0
      ? html`<p class="muted">Nobody is on this team yet.</p>`
      : html`<ul class="list setting-list">
          ${members.map((m) =>
            row({
              lead: avatar(m.username),
              title: html`<a href="/${m.username}"
                >${m.displayName || m.username}</a
              >`,
              meta: html`@${m.username}${m.role === "member" ? "" : html` · ${m.role}`}`,
              trail: when(
                !protectedTeam || members.length > 1,
                () =>
                  confirmAction({
                    action: `${teamBase}/remove?user=${encodeURIComponent(m.username)}`,
                    verb: "Remove",
                    size: "sm",
                    label: `Remove ${m.username}`,
                  }),
              ),
            }),
          )}
        </ul>`}
  </section>
  <section class="settings-block">
    <h2>Add a member</h2>
    <form method="post" action="${teamBase}/add">
      ${uiField({
        label: "Username",
        name: "user",
        required: true,
        hint: "Their username on this forge.",
      })}
      ${selectField({
        label: "Role",
        name: "role",
        hint: "An agent's role is its seat on the org's repositories.",
        options: TEAM_ROLES.map((r) => ({ value: r, label: r, selected: r === "member" })),
      })}
      <div class="form-actions">
        ${btn("Add member", { variant: "primary" })}
      </div>
    </form>
  </section>
  ${when(!protectedTeam, () =>
    html`<section class="settings-block">
      <h2>Delete this team</h2>
      <p class="muted small mb">
        Deleting ${team.name} revokes its ${team.permission} access for
        ${members.length} ${members.length === 1 ? "person" : "people"}.
        Repositories are untouched.
      </p>
      ${confirmAction({ action: `${teamBase}/delete`, verb: "Delete team" })}
    </section>`,
  )}`;

  const response = page({
    ctx,
    title: `${team.name} · ${org.username}`,
    crumbs: [
      { label: org.username, href: `/${org.username}` },
      { label: team.name, href: teamBase },
    ],
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
  const rawRole = field(r.form, "role");
  if (rawRole !== "" && !isTeamRole(rawRole))
    return flashTo(ctx, dest, { tone: "danger", message: `A role is one of ${TEAM_ROLES.join(", ")}.` });
  const role = isTeamRole(rawRole) ? rawRole : undefined;
  const added = addTeamMember(ctx.app, ctx.auth.user, r.org, r.team, username, role);
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: addRefusal(added.error, username),
    });
  return flashTo(ctx, dest, {
    message: addedSays(added.value.added, username, r.team.name),
  });
}

// POST /:owner/-/teams/:team/remove
export async function teamMemberRemove(ctx: Ctx): Promise<Response> {
  const r = await teamAction(ctx);
  if (r instanceof Response) return r;
  // The confirm page posts to its `to` path exactly, so the member arrives
  // in the query; a form that names one still wins.
  const username = (
    field(r.form, "user") ||
    ctx.url.searchParams.get("user") ||
    ""
  ).trim();
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
      message: removeRefusal(removed.error, username, r.org.username, r.team.name),
    });
  return flashTo(ctx, dest, {
    message: removedSays(removed.value.removed, username, r.team.name),
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
      message: deleteRefusal(deleted.error, r.team.name),
    });
  return flashTo(ctx, `/${r.org.username}`, {
    message: deletedSays(r.team.name),
  });
}
