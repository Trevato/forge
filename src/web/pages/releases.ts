/**
 * Releases: each kept release of the forge's own code with its short sha, the
 * pull that landed it, when, and — for the one serving — since when it has
 * been healthy. A writer of the forge's repository gets a Roll back button on
 * a kept release whose schema is not behind the live database's; the POST
 * goes through the same refusals and the same health-read swap as
 * `--rollback`, then this process drains.
 */

import { getReposByIds, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { running } from "../../kernel/version.ts";
import type { Ctx } from "../../http/context.ts";
import { listReleases, type Release } from "../../release/record.ts";
import { BOOTED, canRollBackTo, mayRead, mayRollBack, rollBackTo } from "../../release/gate.ts";
import { liveSince, NO_RELEASES_YET } from "../../release/words.ts";
import { notFoundPage, signInFirst, NOT_ADMIN_HERE, SIGN_IN_TO_DO, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, empty, sha, time } from "../ui.ts";
import { holdAs, liftAs } from "../../keeper/hold.ts";
import { keeperPanel } from "./keeper-panel.ts";

/** The live line (`liveSince`) for the home, or nothing when no release is known to be live. */
export function liveLine(ctx: Ctx): Html | undefined {
  const live = running().commit;
  if (live === null || !mayRead(ctx.app, ctx.auth.user)) return undefined;
  return html`<p class="small muted" id="live-release">
    <a href="/releases">${liveSince(html, html`<span class="sha">${live.slice(0, 7)}</span>`, time(BOOTED))}</a>
  </p>`;
}

function pullCell(repos: ReadonlyMap<string, Repo>, r: Release): Html {
  if (r.pullNumber === null) return html`—`;
  const repo = repos.get(r.repoId);
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
  const looking = performance.now();
  const repos = getReposByIds(ctx.app.db, releases.flatMap((r) => (r.pullNumber === null ? [] : [r.repoId])));
  notePhase(ctx.request, "repos", performance.now() - looking);
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
      <td>${pullCell(repos, r)}</td>
      <td>${time(r.createdAt)}</td>
      <td>${isLive ? html`since ${time(BOOTED)}` : html`—`}</td>
      <td>${when(button, () =>
        html`<form method="post" action="/releases/${r.sha}/rollback">${btn("Roll back", { type: "submit" })}</form>`,
      )}</td>
    </tr>`);
  }
  const body =
    rows.length === 0
      ? empty({ icon: "clock", title: "No releases yet", note: NO_RELEASES_YET })
      : card(html`<table class="table">
          <thead><tr><th>Release</th><th>Pull</th><th>Landed</th><th>Healthy</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
  const response = page({
    ctx,
    title: "Releases",
    body: html`<div class="page-head"><h1>Releases</h1></div>${keeperPanel(ctx.app.db, writer)}${body}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function rollbackSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return forbiddenPage(ctx, SIGN_IN_TO_DO);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!mayRollBack(ctx.app, user)) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const target = ctx.params["sha"] ?? "";
  const refuse = (message: string): Response =>
    flashTo(ctx, "/releases", { tone: "danger", message });
  if (!/^[0-9a-f]{40}$/.test(target)) return notFoundPage(ctx);
  const result = await rollBackTo(ctx.app, user, target);
  if (!result.ok) return refuse(result.line);
  return flashTo(ctx, "/releases", { message: `Rolled back to ${target.slice(0, 7)}; it reads healthy.` });
}

/** POST /releases/hold: an owner's hold with a reason, through the function MCP calls. */
export async function releaseHoldSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const held = holdAs(ctx.app, ctx.auth.user, String(form.get("reason") ?? ""));
  return held.ok
    ? flashTo(ctx, "/releases", { message: `Releases held: ${held.value.reason}` })
    : flashTo(ctx, "/releases", { tone: "danger", message: held.message });
}

/** POST /releases/hold/:id/lift: lift an owner's hold. */
export async function liftSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const lifted = liftAs(ctx.app, ctx.auth.user, Number(ctx.params["id"]));
  return lifted.ok
    ? flashTo(ctx, "/releases", { message: `Hold ${lifted.value} lifted.` })
    : flashTo(ctx, "/releases", { tone: "danger", message: lifted.message });
}
