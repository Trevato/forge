/**
 * /flow: the week's budget as pipes a forge admin can turn. The first paint
 * is the whole page (`flow_pipes.ts` draws it, a form per valve turns it);
 * the little script only submits a drag. A turn is `POST /flow/valve`, the
 * suggestion beside a valve is `POST /flow/suggestion`, and both end back
 * here with one sentence of what the next tick will do. The terminal door is
 * `tui/screens/valves.ts`, on the same `readPipes` and the same actions.
 */

import { retryBackup } from "../../actions/backup_retry.ts";
import { alarmBackup, type BackupAlarm } from "../../flow/alarm_backup.ts";
import { acceptSuggestion, turnValveFor, type ValveError } from "../../actions/valves.ts";
import type { Ctx } from "../../http/context.ts";
import type { Pipes, ValveRow } from "../../flow/pipes.ts";
import { flowPicture, LONG_WAIT_MS } from "../../flow/pages.ts";
import { usd } from "../../core/money.ts";
import { count, figure, figures, reading, readingJs } from "../figure.ts";
import { levelWords } from "../../flow/valve.ts";
import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { pipesSvg } from "../flow_pipes.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon, row, time } from "../ui.ts";
import { handoverSection } from "./flow-handover.ts";
import { waitingSection } from "./flow-waiting.ts";
import { estimatesSection } from "./flow-estimates.ts";
import { clogSection } from "./flow-clog.ts";
import { cpuStopsSection } from "./flow-cpu.ts";
import { cpuStops } from "../../flow/cpu_stops.ts";

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/** The script: a drag submits its form, and the words follow the handle. */
export const valveJs = /* js */ `
(function () {
  var words = function (n) {
    return n >= 100 ? "Open: runs start as the crew picks them." : n <= 0 ? "Shut: nothing new starts here until you open it." : n + "% of the week: runs start in turn up to that share, then yield to the other repositories.";
  };
  document.querySelectorAll("form.valve-form").forEach(function (form) {
    var range = form.querySelector("input[type=range]");
    var out = form.querySelector("output");
    if (!range || !out) return;
    range.addEventListener("input", function () { out.textContent = words(Number(range.value)); });
    range.addEventListener("change", function () { form.requestSubmit(); });
  });
})();
`;

function nextWords(v: ValveRow): string {
  if (v.next.queued === 0) return "Nothing queued, so the next tick starts nothing here.";
  const parts = [`${plural(v.next.goes, "run")} start${v.next.goes === 1 ? "s" : ""} in turn`];
  if (v.next.yields > 0) parts.push(`${String(v.next.yields)} yield${v.next.yields === 1 ? "s" : ""} to other repositories`);
  if (v.next.held > 0) parts.push(`${String(v.next.held)} stay${v.next.held === 1 ? "s" : ""} queued, held by the valve`);
  return `Next tick, of ${String(v.next.queued)} queued: ${parts.join(", ")}.`;
}

function valveRow(v: ValveRow, week: number) {
  const turned = v.turned;
  const share = week > 0 ? Math.max(1, Math.round((v.usd / week) * 100)) : 0;
  return row({
    title: html`<span class="valve-name"><a href="/${v.slug}">${v.slug}</a>
      <span class="muted small">${v.usd <= 0 ? "nothing spent this week" : `${usd(v.usd)} this week, ${String(share)}% of the spend`} · ${plural(v.runs, "run")} · ${plural(v.shipped, "pull")} shipped${v.notes > 0 ? html` · ${plural(v.notes, "note")}` : ""}</span></span>`,
    meta: html`<span class="valve-body"><form class="valve-form" method="post" action="/flow/valve">
        <input type="hidden" name="repo" value="${v.slug}" />
        <input class="valve-range" type="range" name="level" min="0" max="100" step="5" value="${String(v.level)}" aria-label="Valve for ${v.slug}: 0 shut, 100 open" />
        <output class="muted small">${levelWords(v.level)}</output>
        ${btn("Set", { size: "sm", label: `Set the valve for ${v.slug}` })}
      </form>
      <p class="muted small">${nextWords(v)}</p>
      ${when(
        turned !== undefined,
        () => html`<p class="muted small">${turned!.by} turned it ${String(turned!.from)} → ${String(turned!.to)} ${time(turned!.at)}; since, ${plural(turned!.started, "run")} started.</p>`,
      )}
      ${when(
        v.suggestion !== undefined,
        () => html`<form class="valve-form" method="post" action="/flow/suggestion">
          <input type="hidden" name="repo" value="${v.slug}" />
          <span class="small">You looked here ${plural(v.looks, "time")} this week: ${String(v.suggestion)}% would match. It moves nothing until you tap.</span>
          ${btn(`Take ${String(v.suggestion)}%`, { size: "sm", label: `Set the valve for ${v.slug} to ${String(v.suggestion)}%` })}
        </form>`,
      )}</span>`,
  });
}

/** What stands out this week, in one sentence: who spent the money, and how the valves stand. The figures under it carry the totals. */
export function weekSays(p: Pipes): string {
  if (p.valves.length === 0) return "Nothing was spent, queued or shipped in the last 7 days, so there is no valve to turn yet.";
  const shut = p.valves.filter((v) => v.mode === "shut").length;
  const share = p.valves.filter((v) => v.mode === "share").length;
  const valves =
    shut + share === 0
      ? p.valves.length === 1 ? "Its valve is open." : `All ${String(p.valves.length)} valves are open.`
      : `${[...(shut === 0 ? [] : [`${String(shut)} ${shut === 1 ? "valve is" : "valves are"} shut`]), ...(share === 0 ? [] : [`${String(share)} ${share === 1 ? "is" : "are"} held to a share`])].join(" and ")}.`;
  const top = [...p.valves].sort((a, b) => b.usd - a.usd)[0]!;
  if (p.usd <= 0) return `No money was spent in the last 7 days. ${valves}`;
  const pct = Math.round((top.usd / p.usd) * 100);
  return `${top.slug} spent ${p.valves.length === 1 || pct >= 100 ? "all" : `${String(pct)}%`} of the week's money. ${valves}`;
}

/** The overdue off-box backup as one row: the sentence (with the last failure's cause) and the one action that retries. Nothing when none is overdue. */
export function backupRow(alarm: BackupAlarm) {
  if (!alarm.fired) return html``;
  return html`<ul class="list mb">${row({
    lead: icon("alert"),
    title: html`${alarm.says}`,
    meta: html`<form method="post" action="/flow/backup/retry">${btn("Retry the backup now", { type: "submit", variant: "primary", size: "sm" })}</form>`,
  })}</ul>`;
}

// GET /flow
export async function flowPage(ctx: Ctx): Promise<Response> {
  const waiting = ctx.url.search === "?wait=1";
  if (ctx.url.search !== "" && !waiting) return new Response(null, { status: 301, headers: { location: `/boards${ctx.url.search}` } });
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (!user.isAdmin || user.kind === "agent") return notFoundPage(ctx);
  // What a "Reading…" page asks: it answers when the worker has the picture, and draws nothing.
  if (waiting) {
    const read = await flowPicture(ctx.app, user.id, LONG_WAIT_MS);
    return new Response(null, { status: read === undefined ? 503 : 204, headers: { "cache-control": "no-store" } });
  }
  // The page's picture is read by a worker and kept: nothing here walks the runs, the pulls or git.
  const picture = await timePhaseAsync(ctx.request, "picture", () => flowPicture(ctx.app, user.id));
  if (picture === undefined) {
    return page({
      ctx,
      title: "Flow",
      body: html`<div class="hf bd"><header class="hf-head"><div class="hf-title"><h1>Flow</h1></div></header>
        <section class="bd-now">${reading("Reading what the week's money bought…", "/flow?wait=1", "/flow")}</section></div>`,
      scriptJs: readingJs,
    });
  }
  const p = picture.pipes;
  const open = p.valves.filter((v) => v.mode === "open").length;
  const strip = figures([
    figure("Spent in 7 days", usd(p.usd), "by the crew, at list price", "/settings/crew"),
    figure("Pulls shipped", count(p.shipped), "in 7 days", "/boards?out=landed#out"),
    figure("A pull costs", p.shipped === 0 ? "—" : usd(p.usd / p.shipped), p.shipped === 0 ? "none shipped yet" : "the spend over the pulls", "/settings/crew"),
    figure("Valves open", `${String(open)} of ${String(p.valves.length)}`, "drag one below to give a repository a smaller share of the week; nothing but you turns one", "#valves", null, open === p.valves.length ? null : "attn"),
  ], "This week");
  const body = html`<div class="hf bd">
    <header class="hf-head">
      <div class="hf-title"><h1>Flow</h1></div>
      <nav class="bd-nav" aria-label="Elsewhere">${btn("Boards", { href: "/boards", variant: "ghost" })}${btn("Explore the data", { href: "/boards/data", variant: "ghost" })}</nav>
    </header>
    <section class="bd-now" aria-label="How the week stands">
      <p class="bd-lead" id="flow-week"><strong>${weekSays(p)}</strong></p>
      ${backupRow(alarmBackup(ctx.app.config.dataDir, new Date()))}
      ${clogSection(picture.clog)}
      ${cpuStopsSection(cpuStops(ctx.app.db).stopped, picture.cpuClosed)}
    </section>
    ${p.valves.length === 0 ? null : strip}
    ${waitingSection({ approved: picture.approved, stale: picture.stale, unproposed: picture.unproposed ?? { fires: false, says: "", branches: [] } })}
    ${p.valves.length === 0
      ? null
      : html`<section class="pipes-block" aria-label="Where the week's money went">${pipesSvg(p)}</section>
    <section class="bd-block" id="valves" aria-labelledby="valves-h">
      <header class="bd-head"><h2 id="valves-h">Valves</h2></header>
      <ul class="list">${p.valves.map((v) => valveRow(v, p.usd))}</ul>
    </section>`}
    ${handoverSection(picture.handover)}
    ${estimatesSection(ctx.app.db, ctx.auth.user)}
  </div>`;
  const rendering = performance.now();
  const response = page({ ctx, title: "Flow", body, scriptJs: valveJs });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const ERRORS: Record<ValveError, string> = {
  not_found: "No such repository.",
  invalid_level: "A valve is a whole number from 0 (shut) to 100 (open).",
};

function done(ctx: Ctx, result: ReturnType<typeof turnValveFor>): Response {
  if (!result.ok && result.error === "not_found") return notFoundPage(ctx);
  return flashTo(ctx, "/flow", result.ok ? { message: result.value.from === result.value.to ? `${result.value.repo} already reads so.` : result.value.says } : { tone: "danger", message: ERRORS[result.error] });
}

// POST /flow/valve
export async function valveSet(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return done(ctx, turnValveFor(ctx.app, ctx.auth.user, field(form, "repo"), field(form, "level")));
}

// POST /flow/suggestion
export async function suggestionTake(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return done(ctx, acceptSuggestion(ctx.app, ctx.auth.user, field(form, "repo")));
}

// POST /flow/backup/retry: one snapshot now, through the service's own queue, so two never run at once.
export async function backupRetry(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const retried = await retryBackup(ctx.app, ctx.auth.user);
  if (retried.refused) return notFoundPage(ctx);
  return flashTo(ctx, "/flow", retried.cleared ? { message: retried.says } : { tone: "danger", message: retried.says });
}
