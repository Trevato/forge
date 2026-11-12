/**
 * What outside agents tried, for a forge admin: the last day's non-browser
 * requests to public paths (`http/access_log.ts`), filterable by user agent
 * and path. The log holds no token, cookie or query string, and a hash —
 * never an address — stands for the caller.
 */

import { listAccess } from "../../actions/access_log.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn } from "../ui.ts";
import { accountSections } from "./origins.ts";

// GET /settings/access
export function accessPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const ua = ctx.url.searchParams.get("ua")?.slice(0, 100) ?? "";
  const path = ctx.url.searchParams.get("path")?.slice(0, 200) ?? "";
  const listed = timePhase(ctx.request, "access", () =>
    listAccess(ctx.app, user, {
      ...(ua === "" ? {} : { ua }),
      ...(path === "" ? {} : { path }),
    }),
  );
  if (!listed.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const rows = listed.value.map(
    (l) => html`<tr>
      <td class="break"><span class="mono">${l.method} ${l.path}</span></td>
      <td class="num mono">${String(l.status)}</td>
      <td class="small">${l.t}</td>
      <td class="small">${l.host}</td>
      <td class="num small">${String(l.ms)} ms</td>
      <td class="small">${l.auth ? "signed in" : "anonymous"}</td>
      <td class="mono small">${l.who}</td>
      <td class="break small">${l.ua === "" ? "no user agent" : l.ua}</td>
    </tr>`,
  );
  const body = html`<section class="settings-block">
    <h2>Outside requests</h2>
    <p class="muted small">
      The last day's requests from anything that is not a browser, to public
      paths (issues, the API, MCP, discovery files, sign-in and sign-up).
      Tokens, cookies and query strings are never kept; the hash stands for one
      caller for one day.
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
    ${rows.length === 0
      ? html`<p class="muted small" id="access-none">Nothing in the last day.</p>`
      : html`<div class="table-scroll">
          <table class="table" id="access-list" data-dense>
            <caption class="sr-only">Requests from outside agents in the last day</caption>
            <thead><tr><th scope="col">Request</th><th scope="col" class="num">Status</th><th scope="col">Time</th><th scope="col">Host</th><th scope="col" class="num">Took</th><th scope="col">Caller</th><th scope="col">Hash</th><th scope="col">User agent</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
  </section>`;
  const response = page({
    ctx,
    title: "Access",
    body: html`<div class="page-head"><h1>Access</h1></div>
      ${settingsLayout(
        accountSections("access", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
