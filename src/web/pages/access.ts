/**
 * What outside agents tried, for a forge admin: the last day's non-browser
 * requests to public paths (`http/access_log.ts`), filterable by user agent
 * and path. The log holds no token, cookie or query string, and a hash —
 * never an address — stands for the caller.
 */

import { listAccess } from "../../actions/access_log.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, icon, row } from "../ui.ts";
import { accountSections } from "./origins.ts";

// GET /settings/access
export function accessPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const ua = ctx.url.searchParams.get("ua")?.slice(0, 100) ?? "";
  const path = ctx.url.searchParams.get("path")?.slice(0, 200) ?? "";
  const listed = listAccess(ctx.app, ctx.auth.user, {
    ...(ua === "" ? {} : { ua }),
    ...(path === "" ? {} : { path }),
  });
  if (!listed.ok) return notFoundPage(ctx);
  const rows = listed.value.map((l) =>
    row({
      lead: icon("activity"),
      title: html`<span class="mono">${l.method} ${l.path}</span>
        <span class="mono">${String(l.status)}</span>`,
      meta: html`${l.t} · ${l.host} · ${String(l.ms)} ms ·
        ${l.auth ? "signed in" : "anonymous"} ·
        <span class="mono">${l.who}</span> ·
        ${l.ua === "" ? "no user agent" : l.ua}`,
    }),
  );
  const body = html`${card(
    html`<div class="card-body">
        <p class="muted small">
          The last day's requests from anything that is not a browser, to
          public paths (issues, the API, MCP, discovery files, sign-in and
          sign-up). Tokens, cookies and query strings are never kept; the
          hash stands for one caller for one day.
        </p>
        <form class="row-fields" method="get" action="/settings/access">
          <input
            class="input"
            name="ua"
            value="${ua}"
            placeholder="User agent contains"
            aria-label="User agent contains"
          />
          <input
            class="input mono"
            name="path"
            value="${path}"
            placeholder="/api/"
            aria-label="Path starts with"
          />
          ${btn("Filter", { size: "sm", variant: "primary" })}
        </form>
      </div>
      ${rows.length === 0
        ? html`<div class="card-body">
            <p class="muted small" id="access-none">Nothing in the last day.</p>
          </div>`
        : html`<ul class="list" id="access-list">
            ${rows}
          </ul>`}`,
    {
      head: html`${icon("activity")}
        <h2>Outside requests</h2>`,
      pad: false,
    },
  )}`;
  return page({
    ctx,
    title: "Access",
    body: html`<div class="page-head"><h1>Access</h1></div>
      ${settingsLayout(
        accountSections("access", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}
