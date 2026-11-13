/**
 * An app's durable job runs on the forge (#11596): `/:owner/:name/app/jobs`
 * lists each run (name, key, started, where it is now: running, sleeping until,
 * waiting for, done, failed) and, for a writer, **Cancel** on an unfinished run
 * and **Retry from the failed step** on a failed one. The words are `jobRows`
 * in `actions/jobs.ts`, shared with the API and the MCP tool; this module adds
 * markup. The runs are read from the app itself, so the page wakes it; the app
 * page only links here, and only when the app holds a job timer. A run's text
 * is the app's own and goes through `html`, which escapes it. The forms POST to
 * `/:owner/:name/app/jobs/:id/:action`, same-origin checked by `readForm`.
 */

import { requireWriter } from "../../actions/access.ts";
import { JOB_WORDS, jobRows, jobTimers, steerJob, type JobRunRow } from "../../actions/jobs.ts";
import type { Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { badge, btn, empty, time, type Tone } from "../ui.ts";

const TONE: Record<JobRunRow["status"], Tone> = { running: "attn", sleeping: "default", waiting: "default", done: "success", failed: "danger", cancelled: "default" };

/** A line on the app page, when the app has job timers pending: where to see the runs. */
export function jobsLink(ctx: Ctx, repo: Repo): Html | null {
  if (!requireWriter(ctx.app, ctx.auth.user, repo).ok) return null;
  const n = jobTimers(ctx.app, repo);
  if (n === 0) return null;
  return html`<section class="jobs" id="jobs"><h2>Jobs</h2>
    <p>${String(n)} ${n === 1 ? "run is" : "runs are"} waiting on a timer. <a href="${repoBase(repo)}/app/jobs">See the job runs</a>.</p></section>`;
}

function runRow(base: string, r: JobRunRow): Html {
  const act = (action: string, label: string): Html => html`<form method="post" action="${`${base}/app/jobs/${r.id}/${action}`}">${btn(label, { size: "sm", variant: "outline" })}</form>`;
  return html`<tr>
    <td><code>${r.job}</code></td>
    <td class="break"><code>${r.key}</code></td>
    <td>${r.started === 0 ? null : time(new Date(r.started).toISOString())}</td>
    <td>${badge(r.status, { tone: TONE[r.status] })} <span class="break">${r.now}</span>
      ${r.error === null ? null : html`<br><span class="muted break">${r.error}</span>`}
      ${r.result === null ? null : html`<br><span class="muted break">${r.result}</span>`}</td>
    <td>${r.status === "failed" ? act("retry", "Retry from the failed step") : r.status === "running" || r.status === "sleeping" || r.status === "waiting" ? act("cancel", "Cancel") : null}</td>
  </tr>`;
}

// GET /:owner/:name/app/jobs
export async function jobsPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (ctx.auth.user === undefined) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rows = await timePhaseAsync(ctx.request, "read", () => jobRows(ctx.app, ctx.auth.user!, repo));
  if (!rows.ok && (rows.error === "not_found" || rows.error === "forbidden" || rows.error === "unauthorized")) {
    notePhase(ctx.request, "render", 0);
    return notFoundPage(ctx);
  }
  const base = repoBase(repo);
  const body = !rows.ok
    ? empty({ icon: "alert", title: "The job runs could not be read", note: rows.error === "unreachable" ? JOB_WORDS.unreachable : "Try again in a moment." })
    : rows.value.length === 0
      ? empty({ icon: "clock", title: "No job runs yet", note: "A run appears here when the app starts one with `job(…).start(…)`." })
      : html`<table class="table"><thead><tr><th>Job</th><th>Key</th><th>Started</th><th>Where it is now</th><th></th></tr></thead>
          <tbody>${rows.value.map((r) => runRow(base, r))}</tbody></table>`;
  const rendering = performance.now();
  const out = page({
    ctx,
    title: `Jobs · ${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${pageHead("Job runs")}<section data-live="schedule.steered,run.finished" data-live-repo="${repo.ownerName}/${repo.name}">${body}</section>`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return out;
}

// POST /:owner/:name/app/jobs/:id/:action — then back to the list.
export async function steerJobPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !requireWriter(ctx.app, ctx.auth.user, repo).ok) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const done = await steerJob(ctx.app, ctx.auth.user, repo, ctx.params["id"] ?? "", ctx.params["action"] ?? "");
  const why = done.ok ? undefined : done.error === "unreachable" || done.error === "not_now" || done.error === "invalid" ? JOB_WORDS[done.error] : "Not allowed.";
  return redirect(`${repoBase(repo)}/app/jobs`, { url: ctx.url, forgeUrl: ctx.app.config.url, ...(why === undefined ? {} : { flash: { tone: "danger", message: why } }) });
}
