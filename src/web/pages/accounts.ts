/**
 * Accounts — the owner's one place to see who is on the forge: when each
 * joined and how, what it holds and has spent, and its standing, with the
 * two acts that change standing (suspend, remove) beside it. A forge admin
 * only; anyone else gets the forge's one 404.
 */

import {
  listAccounts,
  removeAccount,
  retirementPlan,
  retireAndRemoveAccount,
  suspendAccount,
  unsuspendAccount,
  verifyAccount,
} from "../../actions/accounts.ts";
import { ACCESS_WORDS, accessUrl, endAllSessions, manageable, resetAccess } from "../../actions/account_access.ts";
import { endAccountSession, revokeAccountToken } from "../../actions/signins.ts";
import { listPasskeys } from "../../core/passkeys.ts";
import { roleOf } from "../../core/roles.ts";
import { listSessions } from "../../core/sessions.ts";
import { listTokensWithClients } from "../../core/oauth.ts";
import { emailVerified } from "../../core/verify.ts";
import { mailConfigured } from "../../actions/verify.ts";
import { listAccounts as readAccounts, originOf, signinReach, type AccountRow } from "../../core/accounts.ts";
import {
  OWNERS_TEAM,
  ownerlessOrgs,
  soleOwnedOrgs,
} from "../../core/orgs.ts";
import { getUserByName, hasPassword, isStandInEmail } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  badge,
  btn,
  confirmAction,
  field as formField,
  row,
  time,
  userLink,
} from "../ui.ts";
import { sessionsCard } from "./account.ts";
import { grantCard } from "./model.ts";
import { accountSections } from "./origins.ts";
import { markOf } from "../../core/marks.ts";
import { requestsCard } from "../requests_card.ts";

function shell(ctx: Ctx, body: Html, status = 200): Response {
  return page(
    {
      ctx,
      title: "Accounts",
      body: html`<div class="page-head"><h1>Accounts</h1></div>
        ${settingsLayout(
          accountSections("accounts", { admin: true }),
          body,
          "Account settings",
        )}`,
    },
    status,
  );
}

function standing(a: AccountRow): Html {
  if (a.removedAt !== null) return badge("Removed", { variant: "outline" });
  if (a.suspendedAt !== null) return badge("Suspended", { tone: "danger" });
  if (a.waiting) return badge("Waiting", { variant: "outline" });
  if (!a.verified) return badge("Email not verified", { variant: "outline" });
  return html``;
}

/** `sole`: the organizations this account is the only person owning. */
function personRow(a: AccountRow, sole: readonly string[]): Html {
  const at = `/settings/accounts/${encodeURIComponent(a.username)}`;
  const how = [
    originOf(a),
    a.address ?? "",
  ].filter((s) => s !== "");
  const holds = [
    `${a.repos} ${a.repos === 1 ? "repository" : "repositories"}`,
    ...(a.apps > 0 ? [`${a.apps} ${a.apps === 1 ? "app" : "apps"}`] : []),
    ...(a.spentUsd > 0 ? [`$${a.spentUsd.toFixed(2)} spent`] : []),
  ];
  // Who may be acted on: a person who is not an admin and is still here.
  const actionable = a.kind === "user" && !a.isAdmin && a.removedAt === null;
  return row({
    nav: true,
    title: html`${userLink(a.username, { mark: markOf(a) })} ${standing(a)}`,
    meta: html`joined
      ${time(a.createdAt)}${how.length > 0 ? html` · ${how.join(" · ")}` : null}
      · ${holds.join(" · ")}${sole.length > 0 && a.suspendedAt === null
        ? html` · only owner of ${sole.join(", ")}`
        : null}${sole.length > 0 && a.suspendedAt !== null
        ? html` · ${badge(`${sole.join(", ")}: no active owner`, { tone: "danger" })}`
        : null}`,
    ...(actionable
      ? { after: html`
          ${btn("Manage account", { href: at, size: "sm", variant: "ghost" })}
          ${a.verified
            ? null
            : html`<form method="post" action="${at}/verify">
                ${btn("Verify email", { type: "submit", size: "sm" })}
              </form>`}
          ${a.suspendedAt === null
            ? confirmAction({ action: `${at}/suspend`, verb: "Suspend", size: "sm" })
            : html`<form method="post" action="${at}/unsuspend">
                ${btn("Unsuspend", { type: "submit", size: "sm" })}
              </form>`}
          ${confirmAction({ action: `${at}/remove`, verb: "Remove", size: "sm" })}
        ` }
      : {}),
  });
}

// GET /settings/accounts
export function accountsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return accountsView(ctx);
}

/** The page, with what an act needs said first (`notice`) when it did not finish. */
function accountsView(ctx: Ctx, notice?: Html, status = 200): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const listed = timePhase(ctx.request, "accounts", () =>
    listAccounts(ctx.app, user),
  );
  if (!listed.ok) return notFoundPage(ctx);
  const query = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 64).toLowerCase();
  const people = query === "" ? listed.value : listed.value.filter((a) => a.username.toLowerCase().includes(query) || a.displayName.toLowerCase().includes(query));
  // Without mail a newcomer cannot prove an address; the owner's word is
  // the only way in, and the page says so where it is given.
  const mail = timePhase(ctx.request, "mail", () => mailConfigured(ctx.app));
  const noMail = mail
    ? null
    : html`<section class="settings-block" id="no-mail">
        <h2>Mail is not configured</h2>
        <p>
          Newcomers cannot verify their email themselves. Verify them here, or
          set <code>MAIL_SMTP_URL</code> and <code>MAIL_FROM</code> under
          <a href="/settings/secrets">Secrets</a>.
        </p>
      </section>`;
  // An organization every owner of which is suspended or removed stays as
  // it is for its members; only the forge's owner can mend it.
  const orphans = timePhase(ctx.request, "orphans", () =>
    ownerlessOrgs(ctx.app.db),
  );
  const ownerless =
    orphans.length === 0
      ? null
      : html`<section class="settings-block" id="ownerless">
          <h2>No active owner</h2>
          <p>
            ${orphans.map(
              (o, i) => html`${i > 0 ? ", " : ""}${userLink(o.username)}`,
            )}
            ${orphans.length === 1 ? "has" : "have"} no active owner: everyone
            on Owners is suspended or removed. Unsuspend one, or add an owner:
            ${orphans.map(
              (o, i) =>
                html`${i > 0 ? ", " : ""}<a href="${ownersTeam(o.username)}"
                    >${o.username}'s Owners</a
                  >`,
            )}.
          </p>
        </section>`;
  const reach = timePhase(ctx.request, "edge-only", () => signinReach(ctx.app.db));
  const stranded = reach.stranded;
  const edgeOnly =
    stranded.length === 0
      ? html`<section class="settings-block">
          <p id="signin-reach">All ${reach.total} accounts can sign in without the platform edge.</p>
        </section>`
      : html`<section class="settings-block">
          <h2 id="signin-reach">${reach.own} of ${reach.total} accounts can sign in without the platform edge.</h2>
          <p>
            ${stranded.length === 1 ? "This account signs" : "These accounts sign"}
            in only through the platform edge, so switching
            <code>signin.edge</code> off would lock
            ${stranded.length === 1 ? "it" : "them"} out. Ask each to add a
            passkey at <a href="/settings/passkeys">Settings → Passkeys</a>:
            ${stranded.map(
              (a, i) =>
                html`${i > 0 ? ", " : ""}${userLink(a.username)}${a.isAdmin
                  ? " (admin)"
                  : ""}`,
            )}.
          </p>
        </section>`;
  const sole = timePhase(ctx.request, "owned", () =>
    people.map((a) => {
      const u = getUserByName(ctx.app.db, a.username);
      return u === undefined
        ? []
        : soleOwnedOrgs(ctx.app.db, u.id).map((o) => o.username);
    }),
  );
  const rendering = performance.now();
  const response = shell(
    ctx,
    html`${notice ?? null}${requestsCard(ctx)}${ownerless}${edgeOnly}${noMail}<section class="settings-block" id="accounts">
      <h2>Who is on this forge</h2>
      <form method="get" action="/settings/accounts" class="form-actions" role="search">
        <input class="input" name="q" type="search" maxlength="64" value="${query}" placeholder="Search by name" aria-label="Search accounts" autocomplete="off" />
        ${btn("Search", { type: "submit", size: "sm" })}
      </form>
      <p class="muted">${query === "" ? "Newest first." : `${people.length} matching.`}</p>
      <ul class="list setting-list" id="accounts-list">
        ${people.map((a, i) => personRow(a, sole[i] ?? []))}
      </ul>
    </section>`,
    status,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** Where an organization's owners are added. */
const ownersTeam = (org: string): string =>
  `/${encodeURIComponent(org)}/-/teams/${encodeURIComponent(OWNERS_TEAM)}`;

/** Before suspending the last active owner of an organization, say so once. */
function confirmSuspend(username: string, orgs: readonly string[]): Html {
  const at = `/settings/accounts/${encodeURIComponent(username)}`;
  return html`<section class="settings-block" id="confirm-suspend">
      <h2>Suspend the only active owner?</h2>
      <p>
        <strong>${username}</strong> is the only active owner of
        ${orgs.join(", ")}. Suspended, nobody can administer
        ${orgs.length === 1 ? "it" : "them"} until they are unsuspended or
        another member is made an owner. Its members keep what they have.
      </p>
      <form method="post" action="${at}/suspend" class="form-actions">
        <input type="hidden" name="confirm" value="1" />
        ${btn("Suspend anyway", { type: "submit", size: "sm", variant: "danger" })}
        ${btn("Remove the organization too", {
          href: `${at}/retire`,
          size: "sm",
          variant: "danger",
        })}
        ${orgs[0] === undefined
          ? null
          : btn("Add an owner first", { href: ownersTeam(orgs[0]), size: "sm" })}
        ${btn("Keep them", { href: "/settings/accounts", size: "sm", variant: "ghost" })}
      </form>
    </section>`;
}

/** A removal refused for a sole-owned organization: the way through, once. */
function refuseRemove(username: string): Html {
  return html`<section class="settings-block" id="refuse-remove">
      <h2>Not removed</h2>
      <p>
        <strong>${username}</strong> is the only owner of an organization
        (named in their row). Make someone else an owner first, or remove the
        organization too after seeing everything that would go. Nothing was
        changed.
      </p>
      <div class="form-actions">
        ${btn("Remove the organization too", {
          href: `/settings/accounts/${encodeURIComponent(username)}/retire`,
          size: "sm",
          variant: "danger",
        })}
      </div>
    </section>`;
}

/** One labelled line of the account card. */
function fact(label: string, value: Html, meta: Html | null): Html {
  return row({ title: html`${label}: ${value}`, ...(meta === null ? {} : { meta }) });
}

/** Whether `username` is another admin, which only the forge's owner may manage. */
function isOtherAdmin(ctx: Ctx, username: string): boolean {
  const named = getUserByName(ctx.app.db, username);
  return named !== undefined && named.kind === "user" && named.isAdmin && named.id !== ctx.auth.user?.id;
}

// GET /settings/accounts/:username — one person, on one screen, with what an admin may do
export function personSignInsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const username = ctx.params.username ?? "";
  const named = getUserByName(ctx.app.db, username);
  // An organization has no sign-ins: its page is its model grant and spend ceilings.
  if (named?.kind === "org" && ctx.auth.user.kind === "user")
    return shell(ctx, grantCard(ctx, named, `/settings/accounts/${encodeURIComponent(named.username)}`));
  // Yourself is your own settings; an agent or a removed account, nobody: no page.
  const found = manageable(ctx.app, ctx.auth.user, username);
  if (!found.ok && !(found.error === "not_allowed" && isOtherAdmin(ctx, username))) return notFoundPage(ctx);
  if (!found.ok)
    return shell(ctx, html`<section class="settings-block"><h2>${userLink(username)}</h2><p class="muted">${ACCESS_WORDS.notAllowed}</p></section>`);
  const user = found.value.user;
  const at = `/settings/accounts/${encodeURIComponent(user.username)}`;
  const db = ctx.app.db;
  const owned = readAccounts(db, user.username)[0];
  const sessions = listSessions(db, user.id);
  const passkeys = listPasskeys(db, user.id);
  const tokens = listTokensWithClients(db, user.id);
  const verified = emailVerified(db, user.id);
  const role = roleOf(db, user);
  const account = html`<section class="settings-block" id="account">
      <h2>${userLink(user.username)}</h2>
      <ul class="list setting-list">
        ${fact("Role", html`${role} ${user.suspendedAt === null ? null : badge("Suspended", { tone: "danger" })}`, html`joined ${time(user.createdAt)}`)}
        ${fact("Email", html`${isStandInEmail(user.email) ? "none" : user.email} ${verified ? badge("Verified") : badge("Not verified", { variant: "outline" })}`, null)}
        ${fact("Signs in with", html`${passkeys.length === 0 ? "no passkeys" : `${passkeys.length} ${passkeys.length === 1 ? "passkey" : "passkeys"}`} · ${hasPassword(db, user.id) ? "a password is set" : "no password"}`, html`never the secrets themselves`)}
        ${owned === undefined
          ? null
          : fact(
              "Owns",
              html`${owned.repos} ${owned.repos === 1 ? "repository" : "repositories"} · ${owned.apps} ${owned.apps === 1 ? "app" : "apps"}`,
              html`${owned.spentUsd > 0 ? `$${owned.spentUsd.toFixed(2)} spent by their crew` : "no crew spend"}`,
            )}
      </ul>
    </section>`;
  const signIns = html`<section class="settings-block" id="sign-ins">
      <h2>Signed in now</h2>
      ${sessions.length === 0
        ? html`<p class="muted">Not signed in on any browser.</p>`
        : html`<ul class="list setting-list">
            ${sessions.slice(0, 5).map((x) =>
              row({
                title: html`${time(x.createdAt)}`,
                meta: html`${x.address === null ? "from an unknown address" : `from ${x.address}`} · last seen ${x.lastSeenAt ? time(x.lastSeenAt) : "not since"}`,
              }),
            )}
          </ul>`}
    </section>`;
  const ordinary = !user.isAdmin;
  const actions = html`<section class="settings-block" id="actions">
      <h2>Actions</h2>
      <form method="get" action="/-/confirm" class="stack">
        <input type="hidden" name="to" value="${at}/reset" />
        ${formField({ label: "Also sign them out everywhere", name: "endSessions", type: "checkbox", value: "1", checked: true })}
        <div class="form-actions">
          ${btn("Reset access", { type: "submit", variant: "danger", size: "sm" })}
          ${confirmAction({ action: `${at}/end-sessions`, verb: "End all sessions", size: "sm" })}
        </div>
      </form>
      ${ordinary
        ? html`<div class="form-actions">
            ${verified
              ? null
              : html`<form method="post" action="${at}/verify">${btn("Verify email", { type: "submit", size: "sm" })}</form>`}
            <form method="post" action="/settings/people/${encodeURIComponent(user.username)}/role">
              <input type="hidden" name="role" value="${role === "member" ? "guest" : "member"}" />
              <input type="hidden" name="back" value="${at}" />
              ${btn(role === "member" ? "Make guest" : "Make member", { type: "submit", size: "sm" })}
            </form>
            ${user.suspendedAt === null
              ? confirmAction({ action: `${at}/suspend`, verb: "Suspend", size: "sm" })
              : html`<form method="post" action="${at}/unsuspend">${btn("Unsuspend", { type: "submit", size: "sm" })}</form>`}
            ${confirmAction({ action: `${at}/remove`, verb: "Remove account", size: "sm" })}
          </div>`
        : null}
    </section>`;
  const tokenList = html`<section class="settings-block" id="tokens">
      <h2>Access tokens</h2>
      <p class="muted">Revoking one ends it at once; the person can sign in again.</p>
      ${tokens.length === 0
        ? html`<p class="muted">No access tokens.</p>`
        : html`<ul class="list setting-list">
            ${tokens.map((t) =>
              row({
                title: html`${t.name} ${badge(t.scope)}`,
                meta: html`made ${time(t.createdAt)} · last used ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}`,
                after: confirmAction({ action: `${at}/tokens/${t.id}/delete`, verb: "Revoke", size: "sm" }),
              }),
            )}
          </ul>`}
    </section>`;
  return shell(
    ctx,
    html`${account}${actions}${signIns}${ordinary ? html`${grantCard(ctx, user, at)}${tokenList}${sessionsCard(sessions, at)}` : null}`,
  );
}

// POST /settings/accounts/:username/(reset|end-sessions)
export function accessAct(act: "reset" | "end-sessions") {
  return async (ctx: Ctx): Promise<Response> => {
    if (!ctx.auth.user) return signInFirst(ctx);
    if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const username = ctx.params.username ?? "";
    const back = `/settings/accounts/${encodeURIComponent(username)}`;
    const refused = (error: "not_found" | "not_allowed"): Response =>
      error === "not_found" ? notFoundPage(ctx) : flashTo(ctx, back, { tone: "danger", message: ACCESS_WORDS.notAllowed });
    const browsers = (n: number): string => `${n} ${n === 1 ? "browser" : "browsers"}`;
    if (act === "end-sessions") {
      const done = endAllSessions(ctx.app, ctx.auth.user, username);
      if (!done.ok) return refused(done.error);
      return flashTo(ctx, back, { message: `${username} is signed out of ${browsers(done.value.sessionsEnded)}.` });
    }
    const done = await resetAccess(ctx.app, ctx.auth.user, username, { endAll: field(form, "endSessions") === "1" });
    if (!done.ok) return refused(done.error);
    const link = done.value.token === undefined ? undefined : accessUrl(ctx.app, done.value.token);
    return flashTo(ctx, back, {
      message: `Link made for ${username}; it works once, for an hour.${done.value.mailed ? " It was also mailed to them." : ""}${done.value.sessionsEnded > 0 ? ` Signed out of ${browsers(done.value.sessionsEnded)}.` : ""}`,
      ...(link === undefined ? {} : { code: link }),
    });
  };
}

// POST /settings/accounts/:username/(tokens|sessions)/:id/delete
export function signInAct(what: "token" | "session") {
  return async (ctx: Ctx): Promise<Response> => {
    if (!ctx.auth.user) return signInFirst(ctx);
    if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const username = ctx.params.username ?? "";
    const id = ctx.params.id ?? "";
    const done =
      what === "token"
        ? revokeAccountToken(ctx.app, ctx.auth.user, username, id)
        : endAccountSession(ctx.app, ctx.auth.user, username, id);
    if (!done.ok) return notFoundPage(ctx);
    return flashTo(ctx, `/settings/accounts/${encodeURIComponent(username)}`, {
      message: what === "token" ? "Token revoked." : "Browser signed out.",
    });
  };
}

const cannotDo = (ctx: Ctx): Response =>
  flashTo(ctx, "/settings/accounts", {
    message: "You cannot do that to yourself, another admin, or an agent.",
    tone: "danger",
  });

type Act = "suspend" | "unsuspend" | "remove" | "verify";

const DONE: Readonly<Record<Act, string>> = {
  suspend: "suspended",
  unsuspend: "unsuspended",
  remove: "removed",
  verify: "verified",
};

// POST /settings/accounts/:username/(suspend|unsuspend|remove)
export function accountAct(act: Act) {
  return async (ctx: Ctx): Promise<Response> => {
    if (!ctx.auth.user) return signInFirst(ctx);
    if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const username = ctx.params.username ?? "";
    const done =
      act === "suspend"
        ? await suspendAccount(ctx.app, ctx.auth.user, username, {
            confirmed: field(form, "confirm") === "1",
          })
        : act === "unsuspend"
          ? unsuspendAccount(ctx.app, ctx.auth.user, username)
          : act === "verify"
            ? verifyAccount(ctx.app, ctx.auth.user, username)
            : await removeAccount(ctx.app, ctx.auth.user, username);
    if (!done.ok) {
      if (done.error === "not_found") return notFoundPage(ctx);
      if (act === "remove" && done.error === "last_owner")
        return accountsView(ctx, refuseRemove(username), 409);
      if (act === "suspend" && done.error === "last_owner") {
        const user = getUserByName(ctx.app.db, username);
        const orgs =
          user === undefined
            ? []
            : soleOwnedOrgs(ctx.app.db, user.id).map((o) => o.username);
        return accountsView(ctx, confirmSuspend(username, orgs), 409);
      }
      return flashTo(ctx, "/settings/accounts", {
        message:
          done.error === "not_allowed"
            ? "You cannot do that to yourself, another admin, or an agent."
            : done.error === "last_owner"
              ? `${username} is the only person owning an organization (named in their row). Make someone else an owner first; nothing was changed.`
              : "That did not finish; nothing was lost. Try again.",
        tone: "danger",
      });
    }
    return flashTo(ctx, "/settings/accounts", {
      message: `${username} ${DONE[act]}.`,
    });
  };
}

// GET /settings/accounts/:username/retire — everything removal would take; removes nothing
export function retirePage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const username = ctx.params.username ?? "";
  const plan = retirementPlan(ctx.app, ctx.auth.user, username);
  if (!plan.ok)
    return plan.error === "not_allowed" ? cannotDo(ctx) : notFoundPage(ctx);
  const at = `/settings/accounts/${encodeURIComponent(username)}`;
  const { orgs, own } = plan.value;
  const repoList = (repos: { name: string; app: string | null }[]) =>
    repos.map(
      (r, i) =>
        html`${i > 0 ? ", " : ""}${r.name}${r.app === null ? null : html` (app ${r.app})`}`,
    );
  return shell(
    ctx,
    html`<section class="settings-block" id="retire">
        <h2>Remove ${username}</h2>
        <p>
          ${orgs.length === 0 && own.length === 0
            ? html`Removing <strong>${username}</strong> removes only the account.`
            : html`Removing <strong>${username}</strong> also removes
              ${own.length === 0
                ? null
                : html`${own.length === 1 ? "the repository" : "the repositories"} they own`}${own.length >
                0 && orgs.length > 0
                  ? " and "
                  : null}${orgs.length === 0
                  ? null
                  : html`the ${orgs.length === 1 ? "organization" : "organizations"} they
                    alone own`}, with everything below.`}
          This cannot be undone.
        </p>
        ${orgs.length === 0 && own.length === 0
          ? html`<p class="muted">They own no organization alone.</p>`
          : null}
        <ul class="list setting-list">
          ${own.length === 0
            ? null
            : row({ title: username, meta: html`${repoList(own)}` })}
          ${orgs.map((o) =>
            row({
              title: o.org,
              meta: html`${o.repos.length === 0 ? "no repositories" : repoList(o.repos)}
                · teams: ${o.teams.length === 0 ? "none" : o.teams.join(", ")}`,
            }),
          )}
        </ul>
        <form method="post" action="${at}/retire" class="form-actions">
          <input type="hidden" name="confirm" value="1" />
          ${btn("Remove everything", { type: "submit", size: "sm", variant: "danger" })}
          ${btn("Keep them", { href: "/settings/accounts", size: "sm", variant: "ghost" })}
        </form>
      </section>`,
  );
}

// POST /settings/accounts/:username/retire
export async function retireAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const username = ctx.params.username ?? "";
  const done = await retireAndRemoveAccount(ctx.app, ctx.auth.user, username, {
    confirmed: field(form, "confirm") === "1",
  });
  if (!done.ok) {
    if (done.error === "confirm_required")
      return flashTo(ctx, `/settings/accounts/${encodeURIComponent(username)}/retire`, {
        message: "Confirm to remove; nothing was changed.",
        tone: "danger",
      });
    return done.error === "not_allowed" ? cannotDo(ctx) : notFoundPage(ctx);
  }
  const { removed, failed } = done.value;
  const list = html`<ul>
    ${removed.map((n) => html`<li>${n}</li>`)}
  </ul>`;
  const back = btn("Back to accounts", { href: "/settings/accounts", size: "sm" });
  if (failed !== null)
    return shell(
      ctx,
      html`<section class="settings-block">
          <h2>Removal stopped</h2>
          <p>
            <strong>${failed}</strong> would not go. ${removed.length === 0 ? "Nothing was removed yet." : "Removed so far:"}
            Trying again finishes the job.
          </p>
          ${removed.length === 0 ? null : list}
          <form method="post" action="/settings/accounts/${encodeURIComponent(username)}/retire" class="form-actions">
            <input type="hidden" name="confirm" value="1" />
            ${btn("Try again", { type: "submit", size: "sm", variant: "danger" })} ${back}
          </form>
        </section>`,
      500,
    );
  return shell(
    ctx,
    html`<section class="settings-block">
        <h2>${removed.length === 0 ? `${username} was already removed.` : "Removed"}</h2>
        ${removed.length === 0 ? null : list}
        <p>${back}</p>
      </section>`,
  );
}
