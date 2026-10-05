/**
 * The home in the studio: every app as a shelf
 * row (`shelf.ts` draws those — the row is not this page's to decide), and
 * beside it what is happening right now across all of them, and what a
 * person put on you. Built from the same rows and cards as the rest of the
 * forge, from grouped reads only, so the page does not get slower as the
 * apps grow. A stranger gets the door instead: the public apps, live first.
 */

import { appsRuntime, type EnvState } from "../../apps/runtime.ts";
import { crewForRepos } from "../../core/agents.ts";
import { listPublicApps } from "../../core/apps.ts";
import { DEFAULT_PAGE, LOOK_SIZES, looksForApps } from "../../core/looks.ts";
import { getReposByIds, type Repo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { repoBase } from "../chrome.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import { btn, empty, envStateBadge, icon, listCard } from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { lookUrl, pictured } from "../pages/looks.ts";
import { writableAppsOf } from "./asks.ts";
import { productionFactsForRepos, shelfRows } from "./shelf.ts";
import { servingHistory } from "./words.ts";
import { feedJs, feedNote, feedRegion } from "./feed.ts";

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
          action: html`${btn("New app", {
              href: "/apps/new",
              variant: "primary",
            })}
            ${btn("Repositories", { href: "/?mode=dev" })}`,
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

/** How many public apps the door reads, and how many tiles it shows. */
const DOOR_READ = 200;
const DOOR_TILES = 24;

/** Live first: what answers now, then what wakes on a visit, then the rest. */
const LIVENESS: Record<EnvState, number> = {
  running: 0,
  asleep: 1,
  deploying: 2,
  failed: 3,
  stopped: 4,
};

/**
 * The studio's door for a stranger: the public apps as a shelf of
 * pictures, name and one clamped line, live first — and when nothing
 * public is up yet, an empty shelf that says so, never a git pitch. A
 * signed-out reader gets this whatever the mode: dev has no home of its
 * own for someone with nothing to show them.
 *
 * Three grouped reads carry the whole shelf (the apps, their repositories,
 * their looks), and a repository's runtime state is a map lookup
 * (`AppsRuntime.status`), not a process call — so this never gets slower
 * as the forge grows apps, the one page anonymous traffic actually hits.
 */
export function studioDoor(ctx: Ctx): Response {
  const db = ctx.app.db;
  const records = listPublicApps(db, DOOR_READ);
  const repos = getReposByIds(
    db,
    records.map((r) => r.repoId),
  );
  const runtime = appsRuntime(ctx.app);
  const apps = records.flatMap((record) => {
    const repo = repos.get(record.repoId);
    if (repo === undefined) return [];
    const production = (
      runtime === undefined ? [] : runtime.status(record)
    ).find((env) => env.env === "production");
    return [{ record, repo, state: production?.state ?? "stopped" }];
  });
  // `sort` is stable: newest first within each liveness.
  const shown = apps
    .sort((a, b) => LIVENESS[a.state] - LIVENESS[b.state])
    .slice(0, DOOR_TILES);
  const looks = looksForApps(
    db,
    shown.map((a) => a.record.id),
  );
  const tiles = shown.map(({ record, repo, state }) => {
    const ofApp = looks.filter(
      (l) =>
        l.appId === record.id &&
        l.env === "production" &&
        l.page === DEFAULT_PAGE,
    );
    // The thumb alone: it is the one picture taken as a stranger sees the
    // app. The desktop picture is the owner's view, never a stranger's.
    const look = pictured(ofApp, "thumb");
    const base = repoBase(repo);
    return html`<a class="app-tile" href="${base}">
      ${look
        ? html`<img
            class="app-tile-look"
            src="${lookUrl(base, "production", look.commitOid, DEFAULT_PAGE, look.kind)}"
            width="${LOOK_SIZES[look.kind].width}"
            height="${LOOK_SIZES[look.kind].height}"
            alt=""
            loading="lazy"
          />`
        : html`<span class="app-tile-blank" aria-hidden="true"
            >${icon("rocket")}</span
          >`}
      <span class="app-tile-body">
        <span class="app-tile-name">${repo.name}</span>
        ${repo.description !== ""
          ? html`<span
              class="app-tile-desc truncate"
              title="${repo.description}"
              >${repo.description}</span
            >`
          : null}
        ${envStateBadge(state)}
      </span>
    </a>`;
  });

  const body = html`<section class="hero">
      <h1>Apps, live.</h1>
      <p>A software forge that builds and serves its own apps.</p>
      <div class="bar">
        ${ctx.app.config.edgeToken === undefined
          ? html`${btn("Create an account", {
              href: "/signup",
              variant: "primary",
              size: "lg",
            })}
            ${btn("Sign in", { href: "/signin", size: "lg" })}`
          : btn("Sign in", {
              href: edgeLoginUrl("/"),
              variant: "primary",
              size: "lg",
            })}
      </div>
      ${when(
        sshCommand(ctx.app),
        (ssh) =>
          html`<p class="hero-terminal">
            <code class="mono">${ssh}</code>
            <span class="muted"
              >the whole forge in your terminal — your key is your
              identity</span
            >
          </p>`,
      )}
    </section>
    ${tiles.length > 0
      ? html`<div class="mt app-shelf">${tiles}</div>`
      : html`<div class="mt">
          ${empty({
            icon: "rocket",
            title: "Nothing public is up yet",
            note: "Apps made public here show up on this shelf once they run.",
          })}
        </div>`}`;
  return page({ ctx, title: "forge", body });
}
