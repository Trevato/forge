/**
 * Milestones at the front door (#1083): the few biggest open milestones as
 * quiet lines — name, done of total, what landed this week, the estimate —
 * on the home and on an app's page. Read from `core/milestones.ts`, the
 * same numbers as the milestones pages; never spend, which is the owner's
 * and has its own page. A region that has nothing moved paints nothing.
 */

import type { Limb, Plan } from "../../core/milestones.ts";
import type { Repo } from "../../core/repos.ts";
import { PILLAR_DAYS } from "../../core/pillars.ts";
import type { Ctx } from "../../http/context.ts";
import { fragment } from "../layout.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";
import type { User } from "../../core/users.ts";
import { milestoneHref, planFor } from "../pages/milestones.ts";
import { appsOf, writableAppsOf } from "./asks.ts";

/** How many milestones the front door names. */
export const FRONT_MILESTONES = 3;
/** How many apps the home reads plans of, newest first: a bound on the work. */
const REPOS_READ = 30;
/** The events that can move a milestone. */
const MILESTONE_LIVE = "issue.*,pull.merged,pull.closed";

export interface Line {
  readonly repo: Repo;
  readonly limb: Limb;
  readonly estimate: string;
}

/** The biggest open milestones of these repositories, by open work beneath them. */
export function biggestMilestones(
  ctx: Pick<Ctx, "app">,
  repos: readonly Repo[],
  count = FRONT_MILESTONES,
): Line[] {
  const all: { repo: Repo; limb: Limb; plan: Plan }[] = [];
  for (const repo of repos.slice(0, REPOS_READ)) {
    // Spend is never read here: the front door shows no owner facts.
    const plan = planFor(ctx, repo, false, new Date(), false);
    for (const limb of plan.limbs)
      if (!limb.deferred && limb.issue.state === "open" && limb.weight.open > 0)
        all.push({ repo, limb, plan });
  }
  all.sort(
    (a, b) =>
      b.limb.weight.open - a.limb.weight.open ||
      a.limb.issue.number - b.limb.issue.number,
  );
  return all.slice(0, count).map(({ repo, limb, plan }) => ({
    repo,
    limb,
    estimate: plan.milestone(limb.issue.number)?.estimate ?? "",
  }));
}

/** What a line says after its name: how far, what landed, the estimate if there is one. */
export function lineFacts(r: Line, scoped: boolean): string {
  const w = r.limb.weight;
  return [
    scoped ? "" : r.repo.name,
    `${w.done} of ${w.total} done`,
    w.merged > 0 ? `${w.merged} landed in ${PILLAR_DAYS} days` : "quiet this week",
    r.estimate,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** The lines: nothing at all when nothing among them moved this week. */
function lines(rows: readonly Line[], scoped: boolean): Html | null {
  if (!rows.some((r) => r.limb.weight.merged > 0)) return null;
  return html`<ul class="list setting-list">
    ${rows.map((r) =>
      row({
        nav: true,
        href: milestoneHref(repoBase(r.repo), r.limb.issue.number),
        title: r.limb.name,
        meta: html`${lineFacts(r, scoped)}`,
      }),
    )}
  </ul>`;
}

/** The apps whose milestones the home names: the viewer's own, or the public ones for a visitor. */
export function frontApps(ctx: Pick<Ctx, "app">, user: User | undefined): Repo[] {
  return (user ? writableAppsOf(ctx, user) : appsOf(ctx, undefined)).repos;
}

/** The home's region: the viewer's apps, or the public ones for a visitor. */
export function homeMilestones(ctx: Ctx, apps?: readonly Repo[]): Html {
  const repos = apps ?? frontApps(ctx, ctx.auth.user);
  return html`<div
    id="live-milestones"
    data-live="${MILESTONE_LIVE}"
    data-live-src="/live/milestones"
  >
    ${lines(biggestMilestones(ctx, repos), false)}
  </div>`;
}

/** An app's region: its own milestones, for whoever may read it. */
export function appMilestones(ctx: Ctx, repo: Repo): Html {
  return html`<div
    id="live-milestones"
    data-live="${MILESTONE_LIVE}"
    data-live-repo="${repo.ownerName}/${repo.name}"
    data-live-src="${repoBase(repo)}/app/milestones"
  >
    ${lines(biggestMilestones(ctx, [repo]), true)}
  </div>`;
}

// GET /live/milestones — the home's lines alone.
export function liveMilestonesFragment(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  notePhase(ctx.request, "render", 0);
  return fragment(homeMilestones(ctx), { request: ctx.request });
}

// GET /:owner/:name/app/milestones — an app's lines alone.
export function appMilestonesFragment(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  notePhase(ctx.request, "render", 0);
  const repo = loadRepo(ctx);
  if (!repo) return fragment(html``, { status: 404 });
  return fragment(appMilestones(ctx, repo), { request: ctx.request });
}
