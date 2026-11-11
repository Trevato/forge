/**
 * People — every account and its role in one table: guest, member or admin.
 * An admin promotes a guest to member (with a starter model allowance, none
 * by default) or demotes a member, in one same-origin form post. The guards
 * refuse what `CAN` withholds; the card says so in `roleLimits` (`docs/ROLES.md`).
 * On a phone the table scrolls inside its own `data-people` box and a long
 * username wraps anywhere, so the page never scrolls sideways (#9374).
 */

import { setRole } from "../../actions/roles.ts";
import { GRANT_MAX_USD } from "../../core/model_grant.ts";
import { listPeople, roleLimits, type Person } from "../../core/roles.ts";
import { getUserByName, type User } from "../../core/users.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, empty, userLink } from "../ui.ts";
import { accountSections } from "./origins.ts";

/**
 * The apps each username made, by repo name. An admin sees every app, private
 * ones included: this page is admin-only and an app is one row per repo, so
 * no environment is counted twice.
 */
export function appsMade(ctx: Ctx): Map<string, string[]> {
  const rows = ctx.app.db
    .query<{ username: string; name: string }, []>(
      `SELECT u.username, r.name FROM app a JOIN repo r ON r.id = a.repo_id JOIN user u ON u.id = r.owner_id ORDER BY r.name COLLATE NOCASE`,
    )
    .all();
  const made = new Map<string, string[]>();
  for (const r of rows) made.set(r.username, [...(made.get(r.username) ?? []), r.name]);
  return made;
}

// GET /settings/people
export function peoplePage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rows = timePhase(ctx.request, "people", () => listPeople(ctx.app.db));
  const made = appsMade(ctx);
  const rendering = performance.now();
  const line = (p: Person) => {
    const role = p.role;
    const at = `/settings/people/${encodeURIComponent(p.username)}/role`;
    const act =
      role === "admin"
        ? null
        : role === "guest"
          ? html`<form class="row-fields" method="post" action="${at}">
              <input type="hidden" name="role" value="member" />
              <input class="input" name="usd" inputmode="decimal" autocomplete="off"
                aria-label="Starter allowance, dollars a month" placeholder="$ a month, none" size="12" />
              ${btn("Make member", { type: "submit", size: "sm", variant: "primary" })}
            </form>`
          : html`<form class="row-fields" method="post" action="${at}">
              <input type="hidden" name="role" value="guest" />
              ${btn("Make guest", { type: "submit", size: "sm" })}
            </form>`;
    const apps = made.get(p.username) ?? [];
    const count = apps.length;
    const shown = apps.slice(0, 3).map((n) => html`<a href="/${p.username}/${n}">${n}</a>`);
    const standing = p.usdPerMonth === null ? "no allowance" : `$${p.usdPerMonth.toFixed(2)} a month`;
    return html`<tr>
      <td>${userLink(p.username, { nav: true })}<div class="small muted">${count === 0 ? "No apps yet" : count === 1 ? "1 app" : `${count} apps`}${
        count === 0 ? "" : html`: ${shown.flatMap((a, i) => (i === 0 ? [a] : [", ", a]))}${count > 3 ? ` and ${count - 3} more` : ""}`
      }</div></td>
      <td>${badge(role, { tone: role === "guest" ? "default" : "success" })} <span class="small muted">${standing}</span></td>
      <td>${act}</td>
    </tr>`;
  };
  const response = page({
    ctx,
    title: "People",
    body: html`<div class="page-head"><h1>People</h1></div>
      ${settingsLayout(
        accountSections("people", { admin: true }),
        html`<section class="settings-block">
          <h2>Guests, members and admins</h2>
          <p class="muted">Make a guest a member, with an allowance if you like.</p>
          ${
            rows.length === 0
              ? empty({ icon: "users", title: "Nobody has joined yet." })
              : html`<div class="table-scroll" data-people>
                  <table class="table" id="people">
                    <thead><tr><th>Person</th><th>Standing</th><th></th></tr></thead>
                    <tbody>${rows.map(line)}</tbody>
                  </table>
                </div>
                <p class="small muted">Allowances go up to $${GRANT_MAX_USD} a month. ${roleLimits()}</p>`
          }
        </section>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/people/:username/role
export async function roleAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const username = ctx.params.username ?? "";
  const role = field(form, "role");
  if (role !== "member" && role !== "guest") return notFoundPage(ctx);
  const raw = field(form, "usd").trim().replace(/^\$/, "");
  const usd = raw === "" || Number(raw) === 0 ? null : /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  const done = timePhase(ctx.request, "role", () => setRole(ctx.app, ctx.auth.user as User, username, role, usd));
  const back = "/settings/people";
  if (!done.ok) {
    if (done.error === "not_found" || getUserByName(ctx.app.db, username) === undefined) return notFoundPage(ctx);
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        done.error === "invalid_amount"
          ? `An allowance is dollars a month, from 0.01 to ${GRANT_MAX_USD}.`
          : "You cannot change an admin's or an agent's role.",
    });
  }
  return flashTo(ctx, back, {
    message:
      done.value.role === "member"
        ? `${username} is a member${done.value.usdPerMonth === null ? "" : ` with $${done.value.usdPerMonth.toFixed(2)} a month`}.`
        : `${username} is a guest.`,
  });
}
