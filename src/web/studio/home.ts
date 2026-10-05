/**
 * The home in the studio: every app as a shelf
 * row (`shelf.ts` draws those — the row is not this page's to decide), and
 * beside it what is happening right now across all of them, and what a
 * person put on you. Built from the same rows and cards as the rest of the
 * forge, from grouped reads only, so the page does not get slower as the
 * apps grow. A stranger gets the door instead: the forge featured, then the
 * best of what is public (`actions/front.ts`).
 */

import {
  frontPage,
  frontPicksJson,
  setFront,
  type FrontEntry,
  type FrontPage,
  type FrontPicksJson,
} from "../../actions/front.ts";
import { crewForRepos } from "../../core/agents.ts";
import { LOOK_SIZES } from "../../core/looks.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page, redirect } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import {
  btn,
  card,
  empty,
  envStateBadge,
  icon,
  listCard,
  timeAgo,
} from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { writableAppsOf } from "./asks.ts";
import { productionFactsForRepos, shelfRows } from "./shelf.ts";
import { servingHistory } from "./words.ts";
import { feedJs, feedNote, feedRegion } from "./feed.ts";
import { crewKeyNote } from "./crew.ts";
import { spawnedOrg } from "../../spawn/claim.ts";

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
            ${when(user.isAdmin, () =>
              btn("Front page", { href: "/front", size: "sm", icon: "globe" }),
            )}
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

  // A spawned forge says where it lives: the address its person shares.
  const spawned = await spawnedOrg(ctx.app);
  const address = when(
    spawned?.url,
    (url) =>
      html`<p class="small muted" id="forge-address">
        Your forge: <a href="${url}">${new URL(url).host}</a>
      </p>`,
  );
  const body = html`<h1 class="sr-only">Studio</h1>
    ${address} ${costLine}
    <div class="dash">
      <div class="dash-main stack">
        <div class="bar feed-head">
          <span class="spacer"></span>
          <a class="small muted" href="/asked">What you asked for</a>
        </div>
        ${user.isAdmin || appRepos.length > 0 ? crewKeyNote(ctx) : null}
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

/**
 * A shelf tile: picture, name, one clamped line, how it is. The shelf
 * holds only apps with a picture (`frontPage`), so there is no tile
 * without one.
 */
function tile(entry: FrontEntry): Html {
  const { repo, state, picture } = entry;
  if (picture === undefined) return html``;
  return html`<a class="app-tile" href="${repoBase(repo)}">
    <img
      class="app-tile-look"
      src="${picture}"
      width="${LOOK_SIZES.thumb.width}"
      height="${LOOK_SIZES.thumb.height}"
      alt=""
      loading="lazy"
    />
    <span class="app-tile-body">
      <span class="app-tile-name">${repo.name}</span>
      <span class="app-tile-desc truncate" title="${repo.description}"
        >${repo.description !== "" ? repo.description : repo.ownerName}</span
      >
      ${state !== undefined ? envStateBadge(state) : null}
    </span>
  </a>`;
}

/**
 * The featured repository: its picture, and what makes a forge different —
 * the crew at work on it right now, by issue; or, when nobody is, when it
 * last shipped.
 */
function featuredCard(featured: NonNullable<FrontPage["featured"]>): Html {
  const { repo, picture, crew, signals } = featured;
  const base = repoBase(repo);
  const agents = `${crew.running} agent${crew.running === 1 ? "" : "s"}`;
  const work =
    crew.running > 0
      ? html`<p class="front-crew">
            <span class="front-live" aria-hidden="true"></span>
            The crew is at work: ${agents} right now
          </p>
          <ul class="front-issues">
            ${crew.issues.map(
              (i) =>
                html`<li>
                  <a href="${base}/issues/${i.number}"
                    ><span class="muted">#${i.number}</span> ${i.title}</a
                  >
                </li>`,
            )}
          </ul>`
      : signals.shippedAt !== null
        ? html`<p class="front-crew muted">
            Shipped ${timeAgo(signals.shippedAt)}${signals.ships > 0
              ? ` · ${signals.ships} change${signals.ships === 1 ? "" : "s"} merged this month`
              : ""}
          </p>`
        : null;
  return html`<section class="front-featured" aria-label="Featured">
    ${when(
      picture,
      (src) =>
        html`<a class="front-featured-look" href="${base}"
          ><img
            src="${src}"
            width="${LOOK_SIZES.thumb.width}"
            height="${LOOK_SIZES.thumb.height}"
            alt="${repo.name} as it looks now"
        /></a>`,
    )}
    <div class="front-featured-body">
      <span class="small muted">Featured</span>
      <h2><a href="${base}">${repo.ownerName}/${repo.name}</a></h2>
      ${when(repo.description, (d) => html`<p>${d}</p>`)} ${work}
      <div class="bar">${btn("Open", { href: base, variant: "primary" })}</div>
    </div>
  </section>`;
}

/**
 * What a site admin may change about the front page, on the page itself
 * (`/front`): every pin in order with move and unpin, every shown app with
 * pin and hide, every hidden one with show, and a name to pin anything —
 * a private pin waits, unshown, until its repository is public.
 */
function frontControls(ctx: Ctx, front: FrontPage): Html {
  const picks = frontPicksJson(ctx.app);
  const act = (action: string, repo: string, label: string): Html =>
    html`<form method="post" action="/front" class="inline">
      <input type="hidden" name="action" value="${action}" />
      <input type="hidden" name="repo" value="${repo}" />
      ${btn(label, { size: "sm" })}
    </form>`;
  const name = (e: FrontEntry) => `${e.repo.ownerName}/${e.repo.name}`;
  const shownToStrangers = (full: string): boolean => {
    const [owner = "", repoName = ""] = full.split("/");
    const repo = getRepo(ctx.app.db, owner, repoName);
    return repo !== undefined && canRead(ctx.app.db, repo, undefined);
  };
  const unpinnedShown = [
    ...(front.featured !== undefined && !front.featured.pinned ? [front.featured] : []),
    ...front.shelf.filter((e) => !e.pinned),
  ];
  const row = (label: string, controls: Html): Html =>
    html`<li class="row front-pick">
      <span class="mono truncate">${label}</span>
      <span class="spacer"></span>${controls}
    </li>`;
  return card(
    html`<ul class="list">
        ${picks.pinned.map((repo, at) =>
          row(
            `${at + 1}. ${repo}${shownToStrangers(repo) ? "" : " (private: shown once public)"}`,
            html`${when(at > 0, () => act("up", repo, "Up"))}
            ${when(at < picks.pinned.length - 1, () => act("down", repo, "Down"))}
            ${act("unpin", repo, "Unpin")}`,
          ),
        )}
        ${unpinnedShown.map((e) =>
          row(name(e), html`${act("pin", name(e), "Pin")} ${act("hide", name(e), "Hide")}`),
        )}
        ${picks.hidden.map((repo) =>
          row(`${repo} (hidden)`, act("show", repo, "Show")),
        )}
      </ul>
      <form method="post" action="/front" class="bar front-pin-any">
        <input type="hidden" name="action" value="pin" />
        <input
          class="input"
          name="repo"
          placeholder="owner/name"
          aria-label="Repository to pin"
          required
        />
        ${btn("Pin", { size: "sm" })}
      </form>
      <p class="small muted">
        The first pin a stranger can read is featured; the rest lead the
        shelf in this order. The same setting:
        <code class="mono">PUT /api/v1/front</code> and the MCP tool
        <code class="mono">front_page</code>.
      </p>`,
    {
      head: html`${icon("settings")}
        <h2>The front page</h2>`,
      extra: "front-controls",
    },
  );
}

/**
 * The studio's door for a stranger (#686): one path — the forge, a few
 * live apps, open one or sign in. A featured repository the owner picks,
 * shown with its crew at work; then the best of what is public, ranked by
 * real signals with at most two per owner near the top (`actions/front.ts`
 * decides all of it, and the API and MCP answer from the same place); then
 * one link to the rest. A signed-out reader gets this whatever the mode.
 *
 * `/front` is the same page for anyone; a site admin there also gets the
 * controls that decide it.
 */
export function studioDoor(ctx: Ctx): Response {
  const front = frontPage(ctx.app);
  const admin = ctx.auth.user?.isAdmin === true && ctx.url.pathname === "/front";
  const tiles = front.shelf.map(tile);
  const body = html`<section class="hero">
      <h1>Apps, live.</h1>
      <p>A software forge that builds and serves its own apps.</p>
      <div class="bar">
        ${ctx.auth.user !== undefined
          ? null
          : ctx.app.config.edgeToken === undefined
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
    ${when(front.featured, (f) => html`<div class="mt">${featuredCard(f)}</div>`)}
    ${tiles.length > 0
      ? html`<div class="mt app-shelf">${tiles}</div>
          ${when(
            front.total > tiles.length + (front.featured === undefined ? 0 : 1),
            () =>
              html`<p class="mt front-more">
                <a href="/explore?q=kind%3Aapp">All ${front.total} public apps</a>
              </p>`,
          )}`
      : front.featured === undefined
        ? html`<div class="mt">
            ${empty({
              icon: "rocket",
              title: "Nothing public is up yet",
              note: "Apps made public here show up on this shelf once they run.",
            })}
          </div>`
        : null}
    ${when(admin, () => html`<div class="mt front-admin">${frontControls(ctx, front)}</div>`)}`;
  return page({ ctx, title: "forge", body });
}

/** The pick one `/front` button asks for, applied to the current picks. */
function nextPicks(
  current: FrontPicksJson,
  action: string,
  repo: string,
): FrontPicksJson | undefined {
  const pinned = current.pinned.filter((r) => r !== repo);
  const hidden = current.hidden.filter((r) => r !== repo);
  const at = current.pinned.indexOf(repo);
  switch (action) {
    case "pin":
      return { pinned: [...pinned, repo], hidden };
    case "unpin":
    case "show":
      return { pinned, hidden };
    case "hide":
      return { pinned, hidden: [...hidden, repo] };
    case "up":
    case "down": {
      if (at === -1) return undefined;
      const to = Math.max(0, Math.min(pinned.length, at + (action === "up" ? -1 : 1)));
      return { pinned: [...pinned.slice(0, to), repo, ...pinned.slice(to)], hidden };
    }
    default:
      return undefined;
  }
}

// POST /front — one change to the front page's picks, a site admin's.
export async function frontUpdate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!ctx.auth.user.isAdmin) return new Response("forbidden", { status: 403 });
  const repo = field(form, "repo").trim();
  const next = nextPicks(frontPicksJson(ctx.app), field(form, "action"), repo);
  if (next === undefined) return new Response("bad request", { status: 400 });
  const set = setFront(ctx.app, ctx.auth.user, next);
  return redirect("/front", {
    url: ctx.url,
    flash: set.ok
      ? { message: "The front page is updated." }
      : {
          tone: "danger",
          message: set.error.kind === "invalid" ? set.error.message : "Not yours to change.",
        },
  });
}
