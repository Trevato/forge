/**
 * The schedules section of an app's page (#11595): one row per schedule — its
 * next run, its last run and how it went, in the schedule's own timezone —
 * and, for a writer, **Run now** and **Pause** or **Resume**. The wording is
 * `scheduleRows` in `actions/schedules.ts`, shared with the API and the MCP
 * tool; this module adds only markup. Values are the app's own text and go
 * through `html`, which escapes them. A forms POST to
 * `/:owner/:name/app/schedules/:schedule/:action`, same-origin checked by `readForm`.
 */

import { requireWriter } from "../../actions/access.ts";
import { scheduleRows, steerSchedule, when } from "../../actions/schedules.ts";
import { getAppByRepo } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { redirect } from "../layout.ts";
import { badge, btn } from "../ui.ts";

/** The section, or null for an app with no schedule. */
export function schedulesCard(ctx: Ctx, repo: Repo): Html | null {
  const rows = scheduleRows(ctx.app, ctx.auth.user, repo);
  if (!rows.ok || rows.value.length === 0) return null;
  const writer = requireWriter(ctx.app, ctx.auth.user, repo).ok;
  const base = repoBase(repo);
  return html`<section class="schedules" id="schedules" data-live="schedule.steered,run.finished" data-live-repo="${repo.ownerName}/${repo.name}">
    <h2>Schedules</h2>
    <dl>
      ${rows.value.map((r) => {
        const act = (action: string, label: string): Html =>
          html`<form method="post" action="${`${base}/app/schedules/${r.name}/${action}?env=${r.env}`}">${btn(label, { size: "sm", variant: "outline" })}</form>`;
        return html`<dt><code>${r.name}</code>${r.env === "production" ? null : html` ${badge(r.env, { variant: "outline" })}`}</dt>
      <dd>${r.paused ? badge("paused", { variant: "outline" }) : html`next ${r.nextAt === null ? "soon" : when(r.nextAt, r.timezone)}`}
        <span class="muted">· ${r.cron} ${r.timezone} → <code>${r.path}</code></span><br>
        ${r.last === null
          ? html`<span class="muted">never run</span>`
          : html`last ${when(r.last.at, r.timezone)}: ${badge(r.last.status, { variant: "outline" })} ${r.last.status === "ok" ? html`${r.last.durationMs} ms` : html`<span class="break">${r.last.error ?? ""}</span>`}${r.last.late === null ? null : html` <span class="muted">· ran late: ${r.last.late}</span>`}`}
        ${writer ? html`<br>${act("run", "Run now")} ${r.paused ? act("resume", "Resume") : act("pause", "Pause")}` : null}</dd>`;
      })}
    </dl>
  </section>`;
}

// POST /:owner/:name/app/schedules/:schedule/:action — then back to the app page.
export async function steerSchedulePage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !requireWriter(ctx.app, ctx.auth.user, repo).ok || !getAppByRepo(ctx.app.db, repo.id)) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const action = ctx.params["action"];
  if (action !== "run" && action !== "pause" && action !== "resume") return notFoundPage(ctx);
  steerSchedule(ctx.app, ctx.auth.user, repo, ctx.params["schedule"] ?? "", ctx.url.searchParams.get("env") ?? "production", action);
  return redirect(`${repoBase(repo)}#schedules`, { url: ctx.url, forgeUrl: ctx.app.config.url });
}
