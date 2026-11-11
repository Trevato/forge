/**
 * Handing a limb to the planner from its milestone (#761): the preview that
 * lists every issue the planner will be given, the confirm, and taking it
 * back. Over `actions/limb_replan.ts`; the same pattern as `limb.ts`.
 */

import {
  previewReplan,
  replanLimb,
  takeBackLimb,
  type ReplanAction,
} from "../../actions/limb_replan.ts";
import type { Repo } from "../../core/repos.ts";
import { notePhase, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
} from "../chrome.ts";
import { html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { plural } from "../../kernel/plural.ts";
import { btn } from "../ui.ts";
import { issueRow } from "./limb_view.ts";
import { milestoneHref } from "./milestones.ts";

/** GET /:owner/:name/milestones/:number/limb?action=replan — what the planner will be given. */
export function replanPreviewPage(ctx: Ctx, repo: Repo, number: number): Response {
  const plan = timePhase(ctx.request, "plan", () =>
    previewReplan(ctx.app, ctx.auth.user, repo, number),
  );
  if (!plan.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const base = repoBase(repo);
  const p = plan.value;
  const back = milestoneHref(base, number);
  const response = page({
    ctx,
    title: `Re-plan ${p.limb.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "map")}
      <div class="stack mt">
        <p class="small muted"><a href="${back}">${p.limb.title}</a></p>
        <h1>Re-plan “${p.limb.title}”?</h1>
        <p>
          The planner's next pass is given this limb to re-plan as fewer,
          larger pieces. Each issue below is closed as split into what
          replaces it; none is dropped. The crew picks nothing beneath the
          limb until the planner has answered, and you can take it back
          before it starts.
        </p>
      </div>
      <section class="mt" id="replan-issues">
        <h2>${plural(p.issues.length, "issue")} the planner will be given</h2>
        <ul class="list">
          ${p.issues.map((i) => issueRow(base, i))}
        </ul>
      </section>
      ${p.blocked !== undefined
        ? html`<p class="mt" id="replan-refused">
            Not now: ${p.blocked}. <a href="${back}">Back</a>
          </p>`
        : html`<form method="post" action="${back}/limb" class="bar mt">
            <input type="hidden" name="action" value="replan" />
            ${btn("Hand to the planner", { variant: "primary" })}
            ${btn("Back", { href: back, variant: "ghost" })}
          </form>`}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** POST /:owner/:name/milestones/:number/limb with action replan or takeback, its form already read. */
export function replanSubmit(
  ctx: Ctx,
  repo: Repo,
  number: number,
  action: ReplanAction,
): Response {
  if (!Number.isInteger(number)) return notFoundPage(ctx);
  const done =
    action === "replan"
      ? replanLimb(ctx.app, ctx.auth.user, repo, number)
      : takeBackLimb(ctx.app, ctx.auth.user, repo, number);
  if (!done.ok && done.error.code === "not_found") return notFoundPage(ctx);
  const back = milestoneHref(repoBase(repo), number);
  if (done.ok) return redirect(back);
  // Said, not hidden: the press did nothing, and why.
  return page({
    ctx,
    title: `Not done · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "map")}
      <div class="stack mt">
        <h1>${action === "replan" ? "Not handed over" : "Not taken back"}</h1>
        <p id="replan-refused">Nothing changed: ${done.error.message}.</p>
        <p><a href="${back}">Back</a></p>
      </div>`,
  }, 409);
}
