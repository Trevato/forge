/**
 * The home in the studio: signed in, the feed — the composer, then one
 * timeline — with your apps and what is on you beside it (#599). Built from
 * the same cards as the rest of the forge, from grouped reads only, so the
 * page does not get slower as the apps grow. A stranger gets the door instead: the forge featured, then the
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
import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos } from "../../core/apps.ts";
import { WEIGHT_MAX, WEIGHT_NAMES } from "../../core/front.ts";
import { LOOK_SIZES } from "../../core/looks.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
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
import {
  downloadsCard,
  orgsCard,
  terminalCard,
} from "../pages/site.ts";
import { writableAppsOf } from "./asks.ts";
import { needsYouSection, type AsksTop } from "./asks_page.ts";
import { flowCards } from "./flow_card.ts";
import { composer, feedJs, feedNote, feedRegion } from "./feed.ts";
import { homeTabs } from "./home_tabs.ts";
import { crewKeyNote } from "./crew.ts";
import { everydayCard } from "../pages/everyday.ts";
import { nextStepsCard, nextStepsOf } from "../pages/next-steps.ts";
import { spawnedOrg } from "../../spawn/claim.ts";
import { clientApps } from "./client_home.ts";

/** The events that can change what is on you. */
const ON_YOU_LIVE =
  "issue.assigned,pull.assigned,issue.closed,pull.closed,issue.reopened,pull.reopened,pull.merged,fleet.operated";
/** The events that can change how an app on the rail is. */
const APPS_LIVE = "app.serving,app.stopped,run.finished";
/** How many of your apps the rail names before "All apps". */
const RAIL_APPS = 8;

/**
 * Your apps, one step away (#599): a narrow column on a desk — each app's
 * name and how production is — and the verbs that were the shelf's head.
 * The apps' full rows are `/apps`.
 */
function yourApps(ctx: Ctx, user: User): Html {
  const { repos } = writableAppsOf(ctx, user);
  const runtime = appsRuntime(ctx.app);
  const records = appsForRepos(
    ctx.app.db,
    repos.slice(0, RAIL_APPS).map((r) => r.id),
  );
  const rows = repos.slice(0, RAIL_APPS).map((repo) => {
    const record = records.get(repo.id);
    const state =
      record === undefined || runtime === undefined
        ? undefined
        : runtime.status(record).find((env) => env.env === "production")?.state;
    return html`<li class="row home-app">
      <a class="truncate" href="${repoBase(repo)}">${repo.ownerName}/${repo.name}</a>
      <span class="spacer"></span>
      ${state === undefined ? null : envStateBadge(state)}
    </li>`;
  });
  return card(
    html`${rows.length === 0
        ? html`<p class="muted small">No apps yet.</p>`
        : html`<ul class="list">
            ${rows}
          </ul>`}
      <div class="bar home-apps-verbs">
        ${btn(`All apps${repos.length > RAIL_APPS ? ` (${repos.length})` : ""}`, { href: "/apps", size: "sm" })}
        ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}
        ${btn("Repositories", {
          href: `/${user.username}`,
          size: "sm",
          icon: "repo",
        })}
        ${btn("Map", { href: "/map", size: "sm", icon: "map" })}
        ${btn("Audit", { href: "/audit", size: "sm", icon: "shield" })}
        ${btn("Board", { href: "/board", size: "sm", icon: "activity" })}
        ${when(user.isAdmin, () =>
          btn("Front page", { href: "/front", size: "sm", icon: "globe" }),
        )}
      </div>`,
    {
      head: html`${icon("rocket")}
        <h2>Your apps</h2>`,
      pad: false,
      extra: "home-apps",
    },
  );
}

/**
 * Each live region on the home has an address of its own (`data-live-src`),
 * so an event fetches that region — your apps, or what is on you — and not
 * the page; the fragment answers with the same element, id and all.
 */
const appsRegion = (ctx: Ctx, user: User): Html =>
  html`<div id="live-apps" data-live="${APPS_LIVE}" data-live-src="/live/apps">
    ${yourApps(ctx, user)}
  </div>`;

const onYouRegion = (
  ctx: Ctx,
  user: User,
  note?: string,
  section: Html = needsYouSection(ctx, user).body,
): Html =>
  html`<div
    id="live-on-you"
    data-live="${ON_YOU_LIVE}"
    data-live-src="/live/on-you"
  >
    ${note === undefined ? null : html`<p class="small" role="status">${note}</p>`}
    ${section}
  </div>`;

// GET /live/apps — your apps alone, for the region that shows them.
export function liveAppsFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  return fragment(appsRegion(ctx, user), { request: ctx.request });
}

/**
 * What a bulk step on the On you list answers its own script with: the
 * region as it is now and the top bar's Asks link with its new count.
 */
export function onYouAnswer(ctx: Ctx, user: User, note?: string): Response {
  return fragment(html`<div>${onYouRegion(ctx, user, note)}</div>`);
}

// GET /live/on-you — what is on the viewer, alone.
export function liveOnYouFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  return fragment(onYouRegion(ctx, user), { request: ctx.request });
}

/**
 * Home, signed in, is the feed (#599), for every viewer whatever the mode
 * (#625): like opening X — the composer on top, then one timeline of posts
 * (tells, replies, runs, changes, looks), each one tap from its thing. Your
 * apps and what is on you sit in a narrow column on a desk, with what the
 * dashboard that was dev's home kept beside them when there is any: the
 * terminal's command, what is pinned to your machine, your organizations;
 * your repositories are one step away on your own page. On a phone they are
 * a tab away. The app rows and the cost line live on `/apps`.
 */
export async function studioHome(
  ctx: Ctx,
  user: User,
  top?: AsksTop,
): Promise<Response> {
  const needsYou = needsYouSection(ctx, user, top);
  const { repos: appRepos } = writableAppsOf(ctx, user);
  // A spawned forge says where it lives: the address its person shares.
  const spawned = await spawnedOrg(ctx.app);
  const address = when(
    spawned?.url,
    (url) =>
      html`<p class="small muted" id="forge-address">
        Your forge: <a href="${url}">${new URL(url).host}</a>
      </p>`,
  );
  // On a spawned forge its owner's first steps come first, and carry the
  // everyday account themselves (#600); anywhere else, #803's card asks.
  const steps = await nextStepsOf(ctx, user);
  const firstSteps = await nextStepsCard(ctx, user, steps);
  // Its owner sees their apps first and nothing else until they ask (#1812).
  if (
    ctx.url.searchParams.get("all") === null &&
    steps !== undefined
  ) {
    const apps = await clientApps(ctx, user);
    const lean = html`<h1 class="sr-only">Home</h1>
      ${firstSteps} ${address} ${crewKeyNote(ctx)} ${apps}
      <div class="stack">
        ${composer(ctx, user)}
        <p class="small muted">
          <a href="/?all=1">Show everything</a>
        </p>
      </div>`;
    return page({
      ctx,
      title: "Home",
      body: lean,
    });
  }
  const body = html`<h1 class="sr-only">Home</h1>
    ${firstSteps ?? everydayCard(ctx, user)} ${address}
    ${when(
      steps,
      () => html`<p class="small muted" id="lean-home">
        <a href="/">Just my apps</a>
      </p>`,
    )}
    ${homeTabs("feed")}
    <div class="dash">
      <div class="dash-main stack">
        ${onYouRegion(ctx, user, undefined, needsYou.body)} ${composer(ctx, user)}
        <div class="bar feed-head">
          <span class="spacer"></span>
          <a class="small muted" href="/asked">What you asked for</a>
        </div>
        ${flowCards(ctx, user)}
        ${feedNote()}
        ${feedRegion(user, ctx)}
      </div>
      <aside class="dash-rail stack home-rail">
        ${
          // The crew's missing key is the owner's to fix, not the first
          // thing above every post: beside the timeline on a desk, after it
          // on a phone.
          user.isAdmin || appRepos.length > 0 ? crewKeyNote(ctx) : null
        }
        ${appsRegion(ctx, user)}
        ${terminalCard(ctx)} ${downloadsCard(ctx, user)}
        ${orgsCard(ctx, user)}
      </aside>
    </div>`;
  return page({
    ctx,
    title: "Home",
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${feedJs}\n${needsYou.scriptJs}`,
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

/** A weight's name as the controls say it. */
const WEIGHT_LABEL: Record<(typeof WEIGHT_NAMES)[number], string> = {
  forks: "Forks",
  ships: "Shipped",
  use: "Use",
  fresh: "Fresh",
};

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
      <form method="post" action="/front" class="front-weights">
        <input type="hidden" name="action" value="weights" />
        <span class="small muted">What counts, 0 to ${WEIGHT_MAX}:</span>
        ${WEIGHT_NAMES.map(
          (k) =>
            html`<label class="small"
              >${WEIGHT_LABEL[k]}
              <input
                class="input"
                type="number"
                min="0"
                max="${WEIGHT_MAX}"
                step="0.5"
                name="${k}"
                value="${String(picks.weights[k])}"
            /></label>`,
        )}
        ${btn("Rank", { size: "sm" })}
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
  // A share sheet lands here with the shared words in the query; signing in
  // comes back to them rather than to a bare home, so they are not lost.
  const back = ctx.url.pathname === "/" ? "/" + ctx.url.search : "/";
  const nextQuery = back === "/" ? "" : `?next=${encodeURIComponent(back)}`;
  const tiles = front.shelf.map(tile);
  const body = html`<section class="hero">
      <h1>Apps, live.</h1>
      <p>A software forge that builds and serves its own apps.</p>
      <div class="bar">
        ${ctx.auth.user !== undefined
          ? null
          : ctx.app.config.edgeToken === undefined
            ? html`${btn("Create an account", {
                href: `/signup${nextQuery}`,
                variant: "primary",
                size: "lg",
              })}
              ${btn("Sign in", { href: `/signin${nextQuery}`, size: "lg" })}`
            : btn("Sign in", {
                href: edgeLoginUrl(back),
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

/** What one `/front` form asks for, applied to what is set now. */
type FrontChange = {
  pinned: readonly string[];
  hidden: readonly string[];
  weights: Record<string, unknown>;
};

function nextPicks(
  current: FrontPicksJson,
  action: string,
  form: Form,
): FrontChange | undefined {
  const repo = field(form, "repo").trim();
  const weights: Record<string, unknown> = { ...current.weights };
  const pinned = current.pinned.filter((r) => r !== repo);
  const hidden = current.hidden.filter((r) => r !== repo);
  const at = current.pinned.indexOf(repo);
  switch (action) {
    case "weights":
      // Each box a number; one left empty keeps what is set.
      for (const k of WEIGHT_NAMES) {
        const v = field(form, k).trim();
        if (v !== "") weights[k] = Number(v);
      }
      return { pinned: current.pinned, hidden: current.hidden, weights };
    case "pin":
      return { pinned: [...pinned, repo], hidden, weights };
    case "unpin":
    case "show":
      return { pinned, hidden, weights };
    case "hide":
      return { pinned, hidden: [...hidden, repo], weights };
    case "up":
    case "down": {
      if (at === -1) return undefined;
      const to = Math.max(0, Math.min(pinned.length, at + (action === "up" ? -1 : 1)));
      return { pinned: [...pinned.slice(0, to), repo, ...pinned.slice(to)], hidden, weights };
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
  const next = nextPicks(frontPicksJson(ctx.app), field(form, "action"), form);
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
