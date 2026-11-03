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
import {
  accountSignIns,
  endAccountSession,
  revokeAccountToken,
} from "../../actions/signins.ts";
import { mailConfigured } from "../../actions/verify.ts";
import { edgeOnlyAccounts, originOf, type AccountRow } from "../../core/accounts.ts";
import {
  OWNERS_TEAM,
  ownerlessOrgs,
  soleOwnedOrgs,
} from "../../core/orgs.ts";
import { getUserByName } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  empty,
  time,
  userLink,
} from "../ui.ts";
import { sessionsCard } from "./account.ts";
import { ceilingCard, grantCard } from "./model.ts";
import { accountSections } from "./origins.ts";
import { markOf } from "../../core/marks.ts";

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
  if (!a.verified) return badge("Email not verified", { variant: "outline" });
  return html``;
}

/** `sole`: the organizations this account is the only person owning. */
function row(a: AccountRow, sole: readonly string[]): Html {
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
  return html`<li class="row">
    <div class="row-main">
      ${userLink(a.username, { mark: markOf(a) })} ${standing(a)}
      <div class="row-meta">
        joined
        ${time(a.createdAt)}${how.length > 0
          ? html` · ${how.join(" · ")}`
          : null}
        · ${holds.join(" · ")}${sole.length > 0 && a.suspendedAt === null
          ? html` · only owner of ${sole.join(", ")}`
          : null}
      </div>
      ${sole.length > 0 && a.suspendedAt !== null
        ? html`<div class="row-meta">
            ${badge(`${sole.join(", ")}: no active owner`, { tone: "danger" })}
          </div>`
        : null}
    </div>
    ${actionable
      ? html`<div class="row-actions">
          ${btn("Sign-ins", { href: at, size: "sm", variant: "ghost" })}
          ${a.verified
            ? null
            : html`<form method="post" action="${at}/verify">
                ${btn("Verify email", { type: "submit", size: "sm" })}
              </form>`}
          ${a.suspendedAt === null
            ? confirmAction({
                action: `${at}/suspend`,
                verb: "Suspend",
                size: "sm",
              })
            : html`<form method="post" action="${at}/unsuspend">
                ${btn("Unsuspend", { type: "submit", size: "sm" })}
              </form>`}
          ${confirmAction({
            action: `${at}/remove`,
            verb: "Remove",
            size: "sm",
          })}
        </div>`
      : null}
  </li>`;
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
  const people = listed.value;
  // Without mail a newcomer cannot prove an address; the owner's word is
  // the only way in, and the page says so where it is given.
  const mail = timePhase(ctx.request, "mail", () => mailConfigured(ctx.app));
  const noMail = mail
    ? null
    : card(
        html`<p>
          Mail is not configured, so newcomers cannot verify their email
          themselves. Verify them here, or set <code>MAIL_SMTP_URL</code> and
          <code>MAIL_FROM</code> under <a href="/settings/secrets">Secrets</a>.
        </p>`,
        { tone: "attn" },
      );
  // An organization every owner of which is suspended or removed stays as
  // it is for its members; only the forge's owner can mend it.
  const orphans = timePhase(ctx.request, "orphans", () =>
    ownerlessOrgs(ctx.app.db),
  );
  const ownerless =
    orphans.length === 0
      ? null
      : card(
          html`<p>
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
          </p>`,
          { tone: "attn" },
        );
  const stranded = timePhase(ctx.request, "edge-only", () =>
    edgeOnlyAccounts(ctx.app.db),
  );
  const edgeOnly =
    stranded.length === 0
      ? null
      : card(
          html`<p>
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
          </p>`,
          { tone: "attn" },
        );
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
    html`${notice ?? null}${ownerless}${edgeOnly}${noMail}${card(
      people.length === 0
        ? empty({ icon: "users", title: "Nobody has joined yet." })
        : html`<ul class="rows">
            ${people.map((a, i) => row(a, sole[i] ?? []))}
          </ul>`,
      {
        head: html`<h2>Who is on this forge</h2>
          <p class="muted">
            Newest first. You hear of each new account on your phone, if you set
            a notify address. Suspending stops an account's sign-in and
            everything its repositories run; removing deletes what it owns.
          </p>`,
      },
    )}`,
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
  return card(
    html`<p>
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
      </form>`,
    { tone: "attn" },
  );
}

/** A removal refused for a sole-owned organization: the way through, once. */
function refuseRemove(username: string): Html {
  return card(
    html`<p>
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
      </div>`,
    { tone: "attn" },
  );
}

// GET /settings/accounts/:username — where one person is signed in
export function personSignInsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const named = getUserByName(ctx.app.db, ctx.params.username ?? "");
  // An organization has no sign-ins: its page is its spend ceilings.
  if (named?.kind === "org" && ctx.auth.user.kind === "user")
    return shell(ctx, ceilingCard(ctx, named, `/settings/accounts/${encodeURIComponent(named.username)}`));
  const seen = accountSignIns(ctx.app, ctx.auth.user, ctx.params.username ?? "");
  // Yourself is your own settings; another admin, an agent, nobody: no page.
  if (!seen.ok || seen.value.user.id === ctx.auth.user.id)
    return notFoundPage(ctx);
  const { user, tokens, sessions } = seen.value;
  const at = `/settings/accounts/${encodeURIComponent(user.username)}`;
  return shell(
    ctx,
    html`${card(
      tokens.length === 0
        ? html`<p class="muted">No access tokens.</p>`
        : html`<ul class="rows">
            ${tokens.map(
              (t) =>
                html`<li class="row">
                  <div class="row-main">
                    <strong>${t.name}</strong> ${badge(t.scope)}
                    <div class="row-meta">
                      made ${time(t.createdAt)} · last used
                      ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}
                    </div>
                  </div>
                  <div class="row-actions">
                    ${confirmAction({
                      action: `${at}/tokens/${t.id}/delete`,
                      verb: "Revoke",
                      size: "sm",
                    })}
                  </div>
                </li>`,
            )}
          </ul>`,
      {
        head: html`<h2>${userLink(user.username)}: where they are signed in</h2>
          <p class="muted">
            Revoking a token or signing out a browser ends it at once; the
            person can sign in again. To stop them signing in, suspend the
            account.
          </p>
          <h3>Access tokens</h3>`,
      },
    )}
    ${grantCard(ctx, user, at)}
    ${sessionsCard(sessions, at)}`,
  );
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
    card(
      html`<p>
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
        <ul class="rows">
          ${own.length === 0
            ? null
            : html`<li class="row">
                <div class="row-main">
                  <strong>${username}</strong>
                  <div class="row-meta">${repoList(own)}</div>
                </div>
              </li>`}
          ${orgs.map(
            (o) => html`<li class="row">
              <div class="row-main">
                <strong>${o.org}</strong>
                <div class="row-meta">
                  ${o.repos.length === 0 ? "no repositories" : repoList(o.repos)}
                </div>
                <div class="row-meta">
                  teams: ${o.teams.length === 0 ? "none" : o.teams.join(", ")}
                </div>
              </div>
            </li>`,
          )}
        </ul>
        <form method="post" action="${at}/retire" class="form-actions">
          <input type="hidden" name="confirm" value="1" />
          ${btn("Remove everything", { type: "submit", size: "sm", variant: "danger" })}
          ${btn("Keep them", { href: "/settings/accounts", size: "sm", variant: "ghost" })}
        </form>`,
      { tone: "attn" },
    ),
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
      card(
        html`<p>
            <strong>${failed}</strong> would not go, so the removal stopped
            there. ${removed.length === 0 ? "Nothing was removed yet." : "Removed so far:"}
            Trying again finishes the job.
          </p>
          ${removed.length === 0 ? null : list}
          <form method="post" action="/settings/accounts/${encodeURIComponent(username)}/retire" class="form-actions">
            <input type="hidden" name="confirm" value="1" />
            ${btn("Try again", { type: "submit", size: "sm", variant: "danger" })} ${back}
          </form>`,
        { tone: "danger" },
      ),
      500,
    );
  return shell(
    ctx,
    card(
      html`<p>
          ${removed.length === 0 ? `${username} was already removed.` : "Removed:"}
        </p>
        ${removed.length === 0 ? null : list} ${back}`,
    ),
  );
}
