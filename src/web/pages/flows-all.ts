/**
 * `/admin/flows` (#9594): every repository's flow lines in one list, with
 * state and when each last moved, filterable by kind and by stale. Site
 * admins only; anyone else gets the not-found page. Reads stored state only.
 */

import { ALL_KINDS, parseKind, readAllFlows } from "../../flows/all.ts";
import type { Health } from "../../flows/view.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, pageHead, settingsLayout } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { accountSections } from "./origins.ts";
import { badge, btn, listCard, row, time, type Tone } from "../ui.ts";

/** Lines drawn at once; the count above says how many matched. */
const SHOWN = 500;

const TONE: Record<Health, Tone> = { ok: "default", behind: "attn", diverged: "danger", unread: "danger", stale: "attn", off: "default", none: "default" };

// GET /admin/flows?kind=&stale=1
export function allFlowsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user?.isAdmin !== true || user.kind === "agent") return notFoundPage(ctx);
  const q = new URL(ctx.request.url).searchParams;
  const kind = parseKind(q.get("kind"));
  const stale = q.get("stale") === "1";
  const lines = timePhase(ctx.request, "flows", () => readAllFlows(ctx.app.db, { ...(kind ? { kind } : {}), stale }));
  const rendering = performance.now();
  const shown = lines.slice(0, SHOWN);
  const filters = html`<form method="get" action="/admin/flows" class="row-fields">
    <label>Kind <select name="kind"><option value="">All</option>${ALL_KINDS.map((k) => html`<option value="${k}" ${k === kind ? html`selected` : null}>${k}</option>`)}</select></label>
    <label><input type="checkbox" name="stale" value="1" ${stale ? html`checked` : null}> Stale only</label>
    ${btn("Filter", { variant: "secondary" })}
  </form>`;
  const rows = shown.map((l) =>
    row({
      href: l.href,
      title: html`${l.repo} · ${l.kind}`,
      meta: html`${l.label} · ${l.at === null ? "never moved" : time(l.at)}`,
      trail: badge(l.state, { tone: TONE[l.health] }),
    }),
  );
  const body = html`${pageHead("Flows across the forge", { sub: `${lines.length} ${lines.length === 1 ? "line" : "lines"}${lines.length > SHOWN ? `, the newest ${SHOWN} shown` : ""}.` })}
    ${filters}
    ${rows.length === 0 ? html`<p class="muted">No flow lines match.</p>` : listCard(rows)}`;
  const response = page({ ctx, title: "Flows · admin", body: settingsLayout(accountSections("adminflows", { admin: true }), body, "Account settings") });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
