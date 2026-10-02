/**
 * The home in the studio: every app as a shelf
 * row (`shelf.ts` draws those — the row is not this page's to decide), and
 * beside it what is happening right now across all of them, and what a
 * person put on you. Built from the same rows and cards as the rest of the
 * forge, from grouped reads only, so the page does not get slower as the
 * apps grow.
 */

import { crewForRepos } from "../../core/agents.ts";
import type { Repo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import { btn, empty, icon, listCard, row } from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { writableAppsOf } from "./asks.ts";
import { productionFactsForRepos, shelfRows } from "./shelf.ts";
import { servingHistory } from "./words.ts";
import { feedJs, feedNote, feedRegion } from "./feed.ts";

/**
 * The home in the studio: your apps as a shelf of
 * rows — and beside it what is happening right now across all of them, and
 * what a person put on you. Built from the same rows and cards as the rest
 * of the forge, so it reads as the forge.
 */
/** The events that can change a row on the shelf. */
const APPS_LIVE =
  "app.serving,app.stopped,run.queued,run.started,run.finished,pull.opened,pull.closed,pull.merged";
/** The events that can change what is on you. */
const ON_YOU_LIVE =
  "issue.assigned,pull.assigned,issue.closed,pull.closed,issue.reopened,pull.reopened,pull.merged";

/**
 * The shelf: every app the viewer can write, one row each. The front door
 * leads with what the viewer can write — their own apps and their
 * organisations' — never widened by a stranger's public app
 * (`writableAppsOf`, not the visibility every reader gets from `appsOf`).
 */
async function shelf(
  ctx: Ctx,
  user: User,
): Promise<{ appRepos: readonly Repo[]; apps: Html }> {
  const { repos: appRepos } = writableAppsOf(ctx, user);
  // Read once, shown twice again: a shipped or failed deploy is a row's own
  // word, and — when nothing is running and no change waits — the rail's.
  const productionFacts = productionFactsForRepos(ctx, appRepos);
  // One memo of production's history for every word on this page: the
  // shelf's rows ask it once per repository.
  const history = servingHistory();
  const appRows = await shelfRows(ctx, appRepos, {
    productionFacts,
    history,
  });
  const apps =
    appRows.length === 0
      ? empty({
          icon: "rocket",
          title: "No apps yet",
          note: "Make one, tell the crew what it is, and watch it come up.",
          action: btn("New app", { href: "/apps/new", variant: "primary" }),
        })
      : listCard(appRows, {
          head: html`${icon("rocket")}
            <h2>Your apps</h2>
            <span class="spacer"></span>
            ${btn("Map", { href: "/map", size: "sm", icon: "map" })}
            ${btn("Audit", { href: "/audit", size: "sm", icon: "shield" })}
            ${btn("Board", { href: "/board", size: "sm", icon: "activity" })}
            ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`,
        });
  return { appRepos, apps };
}

/**
 * Each live region on the home has an address of its own (`data-live-src`),
 * so an event fetches that region — the shelf, or what is on you — and not
 * the page; the fragment answers with the same element, id and all.
 */
const appsRegion = (apps: Html): Html =>
  html`<div id="live-apps" data-live="${APPS_LIVE}" data-live-src="/live/apps">
    ${apps}
  </div>`;

const onYouRegion = (ctx: Ctx, user: User): Html =>
  html`<div
    id="live-on-you"
    data-live="${ON_YOU_LIVE}"
    data-live-src="/live/on-you"
  >
    ${onYouCard(ctx, user) ?? null}
  </div>`;

// GET /live/apps — the shelf alone, for the region that shows it.
export async function liveAppsFragment(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  const { apps } = await shelf(ctx, user);
  return fragment(appsRegion(apps), { request: ctx.request });
}

// GET /live/on-you — what is on the viewer, alone.
export function liveOnYouFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  return fragment(onYouRegion(ctx, user), { request: ctx.request });
}

export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  const { appRepos, apps } = await shelf(ctx, user);

  // What the crew cost today across every app on the shelf, and how many
  // are paused at their ceiling right now — the owner's first question at
  // the front door, in one bounded read each (`spentTodayForRepos`,
  // `crewForRepos`), never a query or an `autonomyStatus` call per app.
  // Every app here is already one the viewer can write, so no further
  // filter is needed to keep the money to the owner's own.
  const costLine = when(appRepos.length > 0, () => {
    const spentToday = spentTodayForRepos(
      db,
      appRepos.map((r) => r.id),
    );
    const crew = crewForRepos(
      db,
      appRepos.map((r) => r.id),
    );
    const spentUsd = appRepos.reduce(
      (sum, r) => sum + (spentToday.get(r.id) ?? 0),
      0,
    );
    const paused = appRepos.filter((r) =>
      isPausedAtCeiling(r, crew, spentToday),
    ).length;
    const noun = `app${appRepos.length === 1 ? "" : "s"}`;
    const sentence = `$${spentUsd.toFixed(2)} spent today across ${appRepos.length} ${noun} you can write`;
    return html`<p class="small muted studio-cost">
      ${sentence} · ${paused} paused at <a href="/map">their ceiling</a>
    </p>`;
  });

  const body = html`<h1 class="sr-only">Studio</h1>
    ${costLine}
    <div class="dash">
      <div class="dash-main stack">
        ${feedNote()}
        ${feedRegion(user, ctx)}
        ${appsRegion(apps)}
      </div>
      <aside class="dash-rail stack">
        ${onYouRegion(ctx, user)}
      </aside>
    </div>`;
  return page({
    ctx,
    title: "Studio",
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${feedJs}`,
  });
}
