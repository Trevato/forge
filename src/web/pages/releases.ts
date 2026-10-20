/**
 * Releases: each kept release of the forge's own code with its short sha, the
 * pull that landed it, when, and — for the one serving — since when it has
 * been healthy. A writer of the forge's repository gets a Roll back button on
 * a kept release whose schema is not behind the live database's; the POST
 * goes through the same refusals and the same health-read swap as
 * `--rollback`, then this process drains.
 */

import { getRepoById } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { User } from "../../core/users.ts";
import { running } from "../../kernel/version.ts";
import type { Ctx } from "../../http/context.ts";
import { listReleases, type Release } from "../../release/record.ts";
import { BOOTED, canRollBackTo, mayRead, mayRollBack, rollBackTo } from "../../release/gate.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, empty, sha, time } from "../ui.ts";

/** "live: <sha> since <time>" for the home, or nothing when no release is known to be live. */
export function liveLine(ctx: Ctx): Html | undefined {
  const live = running().commit;
  if (live === null || !mayRead(ctx.app, ctx.auth.user)) return undefined;
  return html`<p class="small muted" id="live-release">
    <a href="/releases">live: <span class="sha">${live.slice(0, 7)}</span> since ${time(BOOTED)}</a>
  </p>`;
}

function pullCell(ctx: Ctx, r: Release): Html {
  if (r.pullNumber === null) return html`—`;
  const repo = getRepoById(ctx.app.db, r.repoId);
  return repo === undefined
    ? html`#${r.pullNumber}`
    : html`<a href="/${repo.ownerName}/${repo.name}/pulls/${r.pullNumber}">#${r.pullNumber}</a>`;
}

export async function releasesPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (!mayRead(ctx.app, user)) return notFoundPage(ctx);
  const reading = performance.now();
  const releases = listReleases(ctx.app.db);
  notePhase(ctx.request, "releases", performance.now() - reading);
  const live = running().commit;
  const writer = mayRollBack(ctx.app, user);
  const checking = performance.now();
  const rollable = writer
    ? await Promise.all(releases.map((r) => (live !== null && r.sha === live ? false : canRollBackTo(ctx.app, r))))
    : releases.map(() => false);
  notePhase(ctx.request, "rollback", performance.now() - checking);
  const rendering = performance.now();
  const rows: Html[] = [];
  for (const [i, r] of releases.entries()) {
    const isLive = live !== null && r.sha === live;
    const button = rollable[i] === true;
    rows.push(html`<tr>
      <td>${sha(r.sha)} ${when(isLive, () => badge("live", { tone: "success" }))}
        ${when(!r.ok, () => badge("preflight failed", { tone: "danger" }))}</td>
      <td>${pullCell(ctx, r)}</td>
      <td>${time(r.createdAt)}</td>
      <td>${isLive ? html`since ${time(BOOTED)}` : html`—`}</td>
      <td>${when(button, () =>
        html`<form method="post" action="/releases/${r.sha}/rollback">${btn("Roll back", { type: "submit" })}</form>`,
      )}</td>
    </tr>`);
  }
  const body =
    rows.length === 0
      ? empty({ icon: "clock", title: "No releases yet", note: "A pull landed on the forge's own repository is recorded here." })
      : card(html`<table class="table">
          <thead><tr><th>Release</th><th>Pull</th><th>Landed</th><th>Healthy</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
  const response = page({
    ctx,
    title: "Releases",
    body: html`<div class="page-head"><h1>Releases</h1></div>${body}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function rollbackSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return new Response("forbidden", { status: 403 });
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!mayRollBack(ctx.app, user)) return new Response("forbidden", { status: 403 });
  const target = ctx.params["sha"] ?? "";
  const refuse = (message: string): Response =>
    flashTo(ctx, "/releases", { tone: "danger", message });
  if (!/^[0-9a-f]{40}$/.test(target)) return notFoundPage(ctx);
  const result = await rollBackTo(ctx.app, user, target);
  if (!result.ok) return refuse(result.line);
  return flashTo(ctx, "/releases", { message: `Rolled back to ${target.slice(0, 7)}; it reads healthy.` });
}
