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
import { readPipes, type ValveRow } from "../../flow/pipes.ts";
import { levelWords } from "../../flow/valve.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { pipesSvg } from "../flow_pipes.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon, row, time } from "../ui.ts";
import { handoverSection } from "./flow-handover.ts";
import { readDrifts } from "../../flow/alarm_drift.ts";
import { readHandoverLists } from "../../flow/handover_read.ts";
import { readWaiting, waitingSection } from "./flow-waiting.ts";
import { clogSection, readClogView } from "./flow-clog.ts";
import { cpuStopsSection } from "./flow-cpu.ts";
import { cpuClosedPulls } from "../../flow/cpu_closed.ts";
import { cpuStops } from "../../flow/cpu_stops.ts";

const money = (usd: number): string => `$${usd.toFixed(2)}`;
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

function valveRow(v: ValveRow) {
  const turned = v.turned;
  return row({
    lead: icon("activity"),
    title: html`<span class="valve-name"><a href="/${v.slug}">${v.slug}</a>
      <span class="muted small">${money(v.usd)} this week · ${plural(v.runs, "run")} · ${plural(v.shipped, "pull")} shipped${v.notes > 0 ? html` · ${plural(v.notes, "note")}` : ""}</span></span>`,
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
  if (ctx.url.search !== "") return new Response(null, { status: 301, headers: { location: `/boards${ctx.url.search}` } });
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (!user.isAdmin || user.kind === "agent") return notFoundPage(ctx);
  const p = readPipes(ctx.app.db, user.id);
  const body = html`<div class="page-head"><h1>Flow</h1>${btn("Boards", { href: "/boards", variant: "ghost" })}</div>
    <p class="mb">Money flows from the left to shipped on the right, as wide as this week's real spend. Every repository has a valve: drag it to give the repository a share of the week, all the way down to shut. The crew does exactly what the valves say, from the next tick, and nothing but you turns one.</p>
    ${backupRow(alarmBackup(ctx.app.config.dataDir, new Date()))}
    ${clogSection(readClogView(ctx.app.db))}
    ${cpuStopsSection(cpuStops(ctx.app.db).stopped, cpuClosedPulls(ctx.app.db, new Date()))}
    ${waitingSection(await readWaiting(ctx.app.db, ctx.app.reposRoot, new Date()))}
    ${pipesSvg(p)}
    <p class="muted small">${money(p.usd)} spent in the last 7 days; ${plural(p.shipped, "pull")} shipped.</p>
    ${handoverSection(readHandoverLists(ctx.app.db, await readDrifts(ctx.app), Date.now()))}
    ${p.valves.length === 0
      ? html`<p class="muted">No repository has spent, queued or shipped anything this week, so there is no pipe to turn yet.</p>`
      : html`<h2>Valves</h2>
    <ul class="list">${p.valves.map(valveRow)}</ul>`}`;
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
