/**
 * Usage, for a forge admin: every route pattern the router knows with its
 * requests over the last 30 days by role and by surface. The unused ones
 * come first, each with its last use or "never": candidates to drop.
 * Anyone else is told 403, and an agent is never an admin here.
 */

import { USAGE_ADMIN_ONLY } from "../../actions/admin_limits_words.ts";
import { mayManageFlags } from "../../core/flags.ts";
import { ROLES, SURFACES } from "../../core/usage_count.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { routeUsage, WINDOW_DAYS } from "../../core/usage_report.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, empty } from "../ui.ts";
import { usageShell } from "./usage-tabs.ts";

/** Only the keys that were used: "user 5 · agent 2", or nothing. */
const part = (counts: Readonly<Record<string, number>>, keys: readonly string[]) =>
  keys.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${k} ${counts[k]}`).join(" · ");

// GET /settings/usage
export function usagePage(ctx: Ctx, patterns: () => readonly string[]): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  if (!mayManageFlags(user))
    return page(
      {
        ctx,
        title: "Forbidden",
        body: html`<div class="page-head"><h1>403</h1></div>
          ${empty({
            icon: "lock",
            title: "Admins only",
            note: USAGE_ADMIN_ONLY,
            action: btn("Go home", { href: "/", variant: "primary" }),
          })}`,
      },
      403,
    );
  const known = timePhase(ctx.request, "patterns", patterns);
  const rows = timePhase(ctx.request, "usage", () => routeUsage(ctx.app.db, known, new Date()));
  const rendering = performance.now();
  const unused = rows.filter((r) => r.total === 0).length;
  const body = html`<p class="muted small">${String(unused)} of ${String(rows.length)} routes had no request in
      ${String(WINDOW_DAYS)} days; they come first.</p>
    <div class="table-scroll"><table class="table" aria-label="Route usage">
      <thead><tr><th scope="col">Pattern</th><th scope="col" class="num">${String(WINDOW_DAYS)} days</th>
        <th scope="col">By role</th><th scope="col">By surface</th><th scope="col">Last use (UTC)</th></tr></thead>
      <tbody>${rows.map(
        (r) => html`<tr data-unused="${r.total === 0 ? "1" : "0"}">
          <td class="mono">${r.pattern}</td><td class="num mono">${String(r.total)}</td>
          <td class="small muted">${part(r.roles, ROLES)}</td><td class="small muted">${part(r.surfaces, SURFACES)}</td>
          <td class="mono">${r.last === null ? "never" : r.last.replace("T", " ") + ":00"}</td></tr>`,
      )}</tbody>
    </table></div>`;
  const res = usageShell(ctx, "routes", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}
