/**
 * The queue (#11604): `/:owner/:name/queue` shows whether the work is growing or shrinking — facts
 * as rows, the last 14 days a row each, two plain sentences — and the planner's one switch.
 * Server-rendered, no script; the switch is a same-origin POST. What a viewer may not see (sealed
 * issues) is left out of every number and title (`core/sealed.ts`).
 */

import { setPlannerSwitch, switchInput } from "../../actions/planner_switch.ts";
import { growth, oldest, WHO, type Growth } from "../../core/growth.ts";
import { PAUSE_STOPS, pauseSentence, pausedUntil } from "../../core/planner_pause.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { sealedScope } from "../../core/sealed.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, row } from "../ui.ts";

export const DAYS = 14;

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** The totals as rows, the sentences, the suggestion when there is one, and a row for each day. */
export function growthRows(g: Growth): Html {
  const d = g.days;
  const opened = sum(d.map((x) => x.issuesOpened));
  const closed = sum(d.map((x) => x.issuesClosed));
  const net = opened - closed;
  const fact = (title: string, value: string) => row({ title, trail: badge(value) });
  const by = WHO.map((w) => ({ w, n: sum(d.map((x) => x.openedBy[w])) })).filter((x) => x.n > 0);
  return html`<p>${g.sentences.join(" ")}</p>
    ${g.suggest === null ? null : html`<p role="note">${g.suggest}</p>`}
    <ul class="list setting-list" data-growth>
      ${fact("Issues opened", String(opened))}
      ${fact("Issues closed", String(closed))}
      ${fact("Net", `${net > 0 ? "+" : ""}${net}`)}
      ${fact("Issues open now", String(g.open.issues))}
      ${fact("Pulls opened, landed, closed unmerged", `${sum(d.map((x) => x.pullsOpened))}, ${sum(d.map((x) => x.pullsLanded))}, ${sum(d.map((x) => x.pullsClosed))}`)}
      ${fact("Pulls open now", String(g.open.pulls))}
      ${by.map((x) => fact(`Opened by ${x.w}`, String(x.n)))}
    </ul>
    <h2>Day by day</h2>
    <ul class="list setting-list">
      ${[...d].reverse().map((x) => row({ title: x.day, trail: badge(`${x.issuesOpened} opened · ${x.issuesClosed} closed`) }))}
    </ul>`;
}

function switchRow(repo: Repo, until: string | null, owner: boolean): Html {
  const post = `${repoBase(repo)}/queue/planner`;
  const state = html`<p data-planner-switch>${pauseSentence(until)} ${until === null ? null : PAUSE_STOPS}</p>`;
  if (!owner) return state;
  return until !== null
    ? html`${state}<form method="post" action="${post}"><input type="hidden" name="mode" value="on">${btn("Switch the planner on", { variant: "primary" })}</form>`
    : html`${state}<form method="post" action="${post}" class="bar">
        <label>Pause <select class="input" name="mode">
          <option value="owner">until I switch it on</option>
          <option value="week">until the weekly reset</option>
          <option value="until">until the time here (UTC)</option>
        </select></label>
        <input class="input" type="datetime-local" name="at" aria-label="Time, UTC">
        ${btn("Pause the planner", { variant: "primary" })}</form>`;
}

const ago = (iso: string, now: Date) => `${Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000))} days old`;

// GET /:owner/:name/queue
export function queuePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const rendering = performance.now();
  const now = new Date();
  const user = ctx.auth.user;
  const owner = user !== undefined && user.kind !== "agent" && canAdmin(ctx.app.db, repo, user);
  const scope = sealedScope(ctx.app.db, repo, user);
  const g = growth(ctx.app.db, repo, DAYS, now, scope);
  const age = oldest(ctx.app.db, repo.id, scope);
  const until = pausedUntil(ctx.app.db, repo.id, now);
  const base = repoBase(repo);
  const aged = [
    age.pull === null ? null : row({ href: `${base}/pulls/${age.pull.number}`, nav: true, title: html`Oldest open pull: #${age.pull.number} ${age.pull.title}`, trail: badge(ago(age.pull.openedAt, now)) }),
    age.issue === null ? null : row({ href: `${base}/issues/${age.issue.number}`, nav: true, title: html`Oldest issue not started: #${age.issue.number} ${age.issue.title}`, trail: badge(ago(age.issue.openedAt, now)) }),
  ].filter((r): r is Html => r !== null);
  const body = html`${repoHeader(ctx, repo, "issues")}
    ${pageHead("Queue", { sub: "Is the work growing or shrinking?" })}
    ${switchRow(repo, until, owner)}
    <p><a href="${base}/chapters">Chapters</a></p>
    ${aged.length === 0 ? null : html`<ul class="list setting-list">${aged}</ul>`}
    ${growthRows(g)}`;
  const response = page({ ctx, title: `Queue · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/queue/planner
export async function queueSwitch(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = `${repoBase(repo)}/queue`;
  const input = switchInput(field(form, "mode"), field(form, "at"));
  if (input === undefined) return flashTo(ctx, back, { tone: "danger", message: "Choose on, a time, the weekly reset or until you switch it on." });
  const done = setPlannerSwitch(ctx.app, ctx.auth.user, repo, input);
  if (!done.ok)
    return flashTo(ctx, back, { tone: "danger", message: done.error === "invalid" ? "Pick a time in the future, within a year." : "Only the owner switches the planner." });
  return flashTo(ctx, back, { message: pauseSentence(done.value) });
}
