/**
 * Accounts — the owner's one place to see who is on the forge: when each
 * joined and how, what it holds and has spent, and its standing, with the
 * two acts that change standing (suspend, remove) beside it. A forge admin
 * only; anyone else gets the forge's one 404.
 */

import {
  listAccounts,
  removeAccount,
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
import type { AccountRow } from "../../core/accounts.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
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
import { accountSections } from "./origins.ts";

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

function row(a: AccountRow): Html {
  const at = `/settings/accounts/${encodeURIComponent(a.username)}`;
  const how = [
    a.via ?? (a.kind === "agent" ? "crew" : ""),
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
      ${userLink(a.username)} ${standing(a)}
      ${a.isAdmin ? badge("Owner", { variant: "secondary" }) : null}
      ${a.kind === "agent" ? badge("Agent", { variant: "secondary" }) : null}
      <div class="row-meta">
        joined
        ${time(a.createdAt)}${how.length > 0
          ? html` · ${how.join(" · ")}`
          : null}
        · ${holds.join(" · ")}
      </div>
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
  if (!ctx.auth.user) return signInFirst(ctx);
  const listed = listAccounts(ctx.app, ctx.auth.user);
  if (!listed.ok) return notFoundPage(ctx);
  const people = listed.value;
  // Without mail a newcomer cannot prove an address; the owner's word is
  // the only way in, and the page says so where it is given.
  const noMail = mailConfigured(ctx.app)
    ? null
    : card(
        html`<p>
          Mail is not configured, so newcomers cannot verify their email
          themselves. Verify them here, or set <code>MAIL_SMTP_URL</code> and
          <code>MAIL_FROM</code> under <a href="/settings/secrets">Secrets</a>.
        </p>`,
        { tone: "attn" },
      );
  return shell(
    ctx,
    html`${noMail}${card(
      people.length === 0
        ? empty({ icon: "users", title: "Nobody has joined yet." })
        : html`<ul class="rows">
            ${people.map(row)}
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
  );
}

// GET /settings/accounts/:username — where one person is signed in
export function personSignInsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
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
        ? await suspendAccount(ctx.app, ctx.auth.user, username)
        : act === "unsuspend"
          ? unsuspendAccount(ctx.app, ctx.auth.user, username)
          : act === "verify"
            ? verifyAccount(ctx.app, ctx.auth.user, username)
            : await removeAccount(ctx.app, ctx.auth.user, username);
    if (!done.ok) {
      if (done.error === "not_found") return notFoundPage(ctx);
      return flashTo(ctx, "/settings/accounts", {
        message:
          done.error === "not_allowed"
            ? "You cannot do that to yourself, another admin, or an agent."
            : "That did not finish; nothing was lost. Try again.",
        tone: "danger",
      });
    }
    return flashTo(ctx, "/settings/accounts", {
      message: `${username} ${DONE[act]}.`,
    });
  };
}
