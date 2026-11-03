/**
 * The home in the studio: signed in, the feed — the composer, then one
 * timeline — with your apps and what is on you beside it (#599). Built from
 * the same cards as the rest of the forge, from grouped reads only, so the
 * page does not get slower as the apps grow. A stranger gets the door instead: the forge featured, then the
 * best of what is public (`actions/front.ts`).
 */

import { forgeCeiling } from "../../flow/ceiling.ts";
import { liveLine } from "../pages/releases.ts";
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
import { canRead, getRepo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { repoBase, offersSignup, signInFirst, NOT_ADMIN_HERE, forbiddenPage } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page, redirect } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import {
  btn,
  card,
  dot,
  empty,
  envStateBadge,
  icon,
  listCard,
  row,
  timeAgo,
  terminalLine,
} from "../ui.ts";
import {
  downloadsCard,
  orgsCard,
  terminalCard,
} from "../pages/site.ts";
import { writableAppsOf } from "./asks.ts";
import { needsYouSection } from "./asks_page.ts";
import { flowCards } from "./flow_card.ts";
import { composer, feedJs, feedNote, feedRegion, registerWorkerJs } from "./feed.ts";
import { heldLine } from "./held.ts";
import { appChips, movingRegion, tellBox } from "./living.ts";
import { alarmLines, cachedAlarms } from "./alarm_lines.ts";
import { kpiRow, waitingLine } from "./kpi_row.ts";
import { homeWeek } from "./week_line.ts";
import { feedCandidateCache } from "../../feed/feed.ts";
import { notePhase, notePhaseRest, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { idleReason } from "../../crew/idle_reason.ts";
import { kpiCache, panelCache, waitingCache } from "./home_cache.ts";
import { accessFingerprint } from "../../core/access_fingerprint.ts";
import { homeFresh, homeRegion, homeVariant, refreshJs, type HomeRegion } from "./home_last.ts";
import type { KpiTimer } from "../../flow/kpis.ts";
import { archivedAppCount } from "../pages/apps.ts";
import { pinnedPanels, pinnedSlot } from "./pinned.ts";
import { isNavigation, lastVisit, noteVisit } from "../../core/home_visit.ts";
import { sinceYouWere } from "./since.ts";
import { homeTabs, unshippedAsks } from "./home_tabs.ts";
import { crewKeyNote } from "./crew.ts";
import { everydayCard } from "../pages/everyday.ts";
import { nextStepsCard, nextStepsOf } from "../pages/next-steps.ts";
import { spawnedOrg } from "../../spawn/claim.ts";
import { clientApps } from "./client_home.ts";
import { passkeyJs } from "../passkey-client.ts";
import { SITE_LINE } from "../site_line.ts";

/** The events that can change what is on you. */
const ON_YOU_LIVE =
  "issue.assigned,pull.assigned,issue.closed,pull.closed,issue.reopened,pull.reopened,pull.merged,fleet.operated";
/** The events that can change how an app on the rail is. */
const APPS_LIVE = "app.serving,app.stopped,run.finished,fleet.operated";
/** How many of your apps the rail names before "All apps". */
const RAIL_APPS = 8;

/**
 * Your apps, one step away (#599): a narrow column on a desk — each app's
 * name and how production is — and the verbs that were the shelf's head.
 * The apps' full rows are `/apps`.
 */
function yourApps(ctx: Ctx, user: User, apps = writableAppsOf(ctx, user)): Html {
  const { repos } = apps;
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
    return row({
      ...(user.isAdmin
        ? {
            lead: html`<input
              type="checkbox"
              name="repo"
              value="${repo.id}"
              aria-label="Select ${repo.name}"
            />`,
          }
        : {}),
      title: html`<a class="truncate break" href="${repoBase(repo)}">${repo.ownerName}/${repo.name}</a>`,
      ...(state === undefined ? {} : { trail: envStateBadge(state) }),
    });
  });
  const archived = archivedAppCount(ctx);
  const list = html`${rows.length === 0
        ? html`<p class="muted small">No apps yet.</p>`
        : html`<ul class="list">
            ${rows}
          </ul>`}
      <div class="bar">
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
        ${when(user.isAdmin && rows.length > 0, () => btn("Archive", { size: "sm" }))}
      </div>
      ${when(
        archived > 0,
        () =>
          html`<p class="muted small"><a href="/apps?archived=1">${archived} archived</a></p>`,
      )}`;
  return card(
    // An admin's list is a form: tick apps, then Archive.
    user.isAdmin && rows.length > 0
      ? html`<form method="post" action="/home/archive">${list}</form>`
      : list,
    {
      head: html`${icon("rocket")}
        <h2>Your apps</h2>`,
      pad: false,
    },
  );
}

/**
 * Each live region on the home has an address of its own (`data-live-src`),
 * so an event fetches that region — your apps, or what is on you — and not
 * the page; the fragment answers with the same element, id and all.
 */
const appsRegion = (ctx: Ctx, user: User, apps?: ReturnType<typeof writableAppsOf>): Html =>
  html`<div id="live-apps" data-live="${APPS_LIVE}" data-live-src="/live/apps">
    ${yourApps(ctx, user, apps)}
  </div>`;

export const onYouRegion = (
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
  const rendering = performance.now();
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const apps = timePhase(ctx.request, "apps", () => writableAppsOf(ctx, user));
  const body = fragment(appsRegion(ctx, user, apps), { request: ctx.request });
  notePhaseRest(ctx.request, "render", rendering, ["apps"]);
  return body;
}

// GET /live/client-apps — a client's apps card alone; 404 to anyone else.
export async function liveClientAppsFragment(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  const steps = user ? await nextStepsOf(ctx, user) : undefined;
  if (!user || steps === undefined) {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  return fragment(await clientApps(ctx, user), { request: ctx.request }); // names session and render itself
}

/**
 * What a bulk step on the On you list answers its own script with: the
 * region as it is now and the asks page's list.
 */
export function onYouAnswer(ctx: Ctx, user: User, note?: string): Response {
  return fragment(html`<div>${onYouRegion(ctx, user, note)}</div>`);
}

// GET /live/on-you — what is on the viewer, alone.
export function liveOnYouFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  const rendering = performance.now();
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = fragment(onYouRegion(ctx, user), { request: ctx.request }); // needsYouSection times "asks"
  notePhaseRest(ctx.request, "render", rendering, ["asks"]);
  return body;
}

/**
 * How each late region of home is drawn for `user` (#7660): the page serves
 * the last drawing from memory and `/live/home/<name>` draws it fresh.
 */
export function homeDraws(ctx: Ctx, user: User): Record<HomeRegion, () => Html | Promise<Html>> {
  const { db } = ctx.app;
  const request = ctx.request;
  return {
    kpis: () => {
      const ceilingUsd = forgeCeiling(ctx.app.config);
      const kpiTime: KpiTimer = (name, fn) => timePhase(request, name, fn);
      const kpiOpts = { idle: () => idleReason(ctx.app, new Date()), dataDir: ctx.app.config.dataDir, time: kpiTime, ...(ceilingUsd === null ? {} : { ceilingUsd }) };
      return html`${timePhase(request, "kpis", () => kpiRow(db, kpiOpts), () => kpiCache(db))}
        ${homeWeek(ctx.app, user)}
        ${alarmLines(cachedAlarms(db, new Date(), ceilingUsd))}`;
    },
    waiting: () => timePhase(request, "waiting", () => waitingLine(db, user), () => waitingCache(db)),
    panels: async () => (await timePhaseAsync(request, "panels", () => pinnedPanels(ctx.app, user), () => panelCache(db))) ?? html``,
    asked: () => homeTabs("feed", timePhase(request, "asked", () => unshippedAsks(db, user))),
    feed: () => timePhase(request, "feed", () => feedRegion(user, ctx), () => feedCandidateCache(db)),
  };
}

// GET /live/home/<region> — one late region of home, drawn fresh, for the page to swap in.
export async function liveHomeFragment(ctx: Ctx, name: HomeRegion): Promise<Response> {
  const user = ctx.auth.user;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!user || ((name === "kpis" || name === "panels") && !user.isAdmin)) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const rendering = performance.now();
  const body = await homeFresh(ctx.app.db, user.id, name, homeVariant(ctx.url), accessFingerprint(ctx.app.db, user), homeDraws(ctx, user)[name]);
  const res = fragment(html`<div>${body}</div>`, { request: ctx.request });
  notePhaseRest(ctx.request, "render", rendering, [name, "vitals"]);
  return res;
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
): Promise<Response> {
  // A spawned forge says where it lives: the address its person shares.
  const spawned = await timePhaseAsync(ctx.request, "spawned", () => spawnedOrg(ctx.app));
  const address = when(
    spawned?.url,
    (url) =>
      html`<p class="small muted" id="forge-address">
        Your forge: <a href="${url}">${new URL(url).host}</a>
      </p>`,
  );
  // On a spawned forge its owner's first steps come first, and carry the
  // everyday account themselves (#600); anywhere else, #803's card asks.
  const { steps, firstSteps } = await timePhaseAsync(ctx.request, "steps", async () => {
    const steps = await nextStepsOf(ctx, user);
    return { steps, firstSteps: await nextStepsCard(ctx, user, steps) };
  });
  // Its owner sees their apps first and nothing else until they ask (#1812).
  if (
    ctx.url.searchParams.get("all") === null &&
    steps !== undefined
  ) {
    const apps = await clientApps(ctx, user);
    const lean = html`<h1 class="sr-only">Home</h1>
      ${firstSteps} ${address} ${crewKeyNote(ctx)} ${heldLine(ctx, user)} ${apps}
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
      // The everyday step makes its account with a passkey (#1890).
      ...(firstSteps ? { scriptJs: passkeyJs } : {}),
    });
  }
  // The client's first screen names its own phases (`clientApps`).
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  // Render is what is left of the page once the named reads are taken out.
  const rendering = performance.now();
  const access = timePhase(ctx.request, "access", () => accessFingerprint(ctx.app.db, user));
  const ask = firstSteps ?? everydayCard(ctx, user);
  const figures = user.isAdmin && steps === undefined;
  const kpis = figures
    ? await homeRegion(ctx.app.db, ctx.request, user.id, "kpis", homeVariant(ctx.url), access, homeDraws(ctx, user).kpis)
    : liveLine(ctx);
  const body = html`<h1 class="sr-only">Home</h1>
    ${tellBox(ctx, user)}
    ${ask} ${address}
    ${timePhase(ctx.request, "held", () => heldLine(ctx, user))}
    <section class="stack" aria-label="The forge">${kpis}</section>
    ${pinnedSlot(ctx.app.db, user)}
    ${timePhase(ctx.request, "moving", () => movingRegion(ctx.app.db, user))}
    ${appChips(ctx, user)}
    ${when(
      steps,
      () => html`<p class="small muted" id="lean-home"><a href="/">Just my apps</a></p>`,
    )}
    <p class="small muted"><a href="/feed">The feed</a></p>`;
  const res = page({
    ctx,
    title: "Home",
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${refreshJs}\n${registerWorkerJs}${ask ? `\n${passkeyJs}` : ""}`,
  });
  notePhaseRest(ctx.request, "render", rendering, ["kpis", "moving", "access"]);
  return res;
}

/**
 * The feed (#8015), kept off home: the composer, then one timeline — what
 * home was before it became the living pipeline — with your apps and what
 * is on you beside it on a desk.
 */
export async function feedPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const { repos: appRepos } = timePhase(ctx.request, "repos", () => writableAppsOf(ctx, user));
  const rendering = performance.now();
  const visitedAt = Date.now();
  const before = timePhase(ctx.request, "visit", () =>
    isNavigation(ctx.request) ? noteVisit(ctx.app.db, user.id, visitedAt) : lastVisit(ctx.app.db, user.id),
  );
  const since = timePhase(ctx.request, "since", () => sinceYouWere(ctx.app.db, user, before, visitedAt));
  const draws = homeDraws(ctx, user);
  const access = timePhase(ctx.request, "access", () => accessFingerprint(ctx.app.db, user));
  const regionOf = (name: HomeRegion): Promise<Html> =>
    homeRegion(ctx.app.db, ctx.request, user.id, name, homeVariant(ctx.url), access, draws[name]);
  const body = html`<h1 class="sr-only">Feed</h1>
    ${await regionOf("waiting")}
    ${user.isAdmin ? await regionOf("panels") : null}
    ${since}
    ${await regionOf("asked")}
    <div class="split" data-rail="wide">
      <div class="stack">
        ${composer(ctx, user)}
        ${flowCards(ctx, user)}
        ${feedNote()}
        ${await regionOf("feed")}
      </div>
      <aside class="stack">
        ${user.isAdmin || appRepos.length > 0 ? crewKeyNote(ctx) : null}
        ${appsRegion(ctx, user)}
        ${terminalCard(ctx)} ${downloadsCard(ctx, user)}
        ${orgsCard(ctx, user)}
      </aside>
    </div>`;
  const res = page({
    ctx,
    title: "Feed",
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${feedJs}\n${refreshJs}`,
  });
  notePhaseRest(ctx.request, "render", rendering, ["waiting", "feed", "asked", "visit", "since", "access", "repos"]);
  return res;
}

/**
 * A shelf tile: picture, name, one clamped line, how it is. The shelf
 * holds only apps with a picture (`frontPage`), so there is no tile
 * without one.
 */
function tile(entry: FrontEntry): Html {
  const { repo, state, picture } = entry;
  if (picture === undefined) return html``;
  const href = repoBase(repo);
  return card(
    html`<a class="look" href="${href}" tabindex="-1" aria-hidden="true"
        ><img
          src="${picture}"
          width="${LOOK_SIZES.thumb.width}"
          height="${LOOK_SIZES.thumb.height}"
          alt=""
          loading="lazy"
      /></a>
      <div class="card-body stack stack-tight">
        <a href="${href}"><strong>${repo.name}</strong></a>
        <span class="muted small truncate" title="${repo.description}"
          >${repo.description !== "" ? repo.description : repo.ownerName}</span
        >
        ${state !== undefined ? envStateBadge(state) : null}
      </div>`,
    { pad: false },
  );
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
      ? listCard([
          row({
            lead: dot("success"),
            title: `The crew is at work: ${agents} right now`,
          }),
          ...crew.issues.map((i) =>
            row({
              href: `${base}/issues/${i.number}`,
              lead: html`<span class="muted">#${i.number}</span>`,
              title: i.title,
            }),
          ),
        ])
      : signals.shippedAt !== null
        ? listCard([
            row({
              title: `Shipped ${timeAgo(signals.shippedAt)}${
                signals.ships > 0
                  ? ` · ${signals.ships} change${signals.ships === 1 ? "" : "s"} merged this month`
                  : ""
              }`,
            }),
          ])
        : null;
  return card(
    html`${when(
        picture,
        (src) =>
          html`<a class="look" href="${base}"
            ><img
              src="${src}"
              width="${LOOK_SIZES.thumb.width}"
              height="${LOOK_SIZES.thumb.height}"
              alt="${repo.name} as it looks now"
          /></a>`,
      )}
      <div class="card-body stack stack-tight">
        <span class="small muted">Featured</span>
        <h2><a href="${base}">${repo.ownerName}/${repo.name}</a></h2>
        ${when(repo.description, (d) => html`<p class="muted">${d}</p>`)} ${work}
        <div class="bar">${btn("Open", { href: base, variant: "primary" })}</div>
      </div>`,
    { pad: false, attrs: html`role="region" aria-label="Featured"` },
  );
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
      <form method="post" action="/front" class="bar">
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
      <form method="post" action="/front" class="bar">
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
      attrs: html`data-front-settings`,
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
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let tiles: Html[] = [];
  const front = timePhase(ctx.request, "shelf", () => frontPage(ctx.app, Date.now(), ctx.request));
  timePhase(ctx.request, "tiles", () => {
    tiles = front.shelf.map(tile);
  });
  // Render is what is left of the page once the shelf read is taken out.
  const rendering = performance.now();
  const admin = ctx.auth.user?.isAdmin === true && ctx.url.pathname === "/front";
  // A share sheet lands here with the shared words in the query; signing in
  // comes back to them rather than to a bare home, so they are not lost.
  const back = ctx.url.pathname === "/" ? "/" + ctx.url.search : "/";
  const nextQuery = back === "/" ? "" : `?next=${encodeURIComponent(back)}`;
  const ssh = sshCommand(ctx.app);
  const body = html`<section class="narrow narrow-wide stack">
      <h1>Apps, live.</h1>
      <p class="muted">${SITE_LINE}</p>
      <div class="bar">
        ${ctx.auth.user !== undefined
          ? null
          : offersSignup(ctx)
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
        ssh,
        (command) => html`<div class="stack-tight">
          ${terminalLine({ command })}
          <p class="muted small">
            The whole forge in your terminal — your key is your identity.
          </p>
        </div>`,
      )}
    </section>
    ${when(front.featured, (f) => html`<div class="mt">${featuredCard(f)}</div>`)}
    ${tiles.length > 0
      ? html`<div class="mt stack" data-shelf>${tiles}</div>
          ${when(
            front.total > tiles.length + (front.featured === undefined ? 0 : 1),
            () =>
              html`<div class="mt">
                ${listCard([
                  row({
                    href: "/explore?q=kind%3Aapp",
                    title: `All ${front.total} public apps`,
                  }),
                ])}
              </div>`,
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
  const res = page({ ctx, title: "forge", body });
  notePhaseRest(ctx.request, "render", rendering, []);
  return res;
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
  if (!ctx.auth.user.isAdmin) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const next = nextPicks(frontPicksJson(ctx.app), field(form, "action"), form);
  if (next === undefined) return new Response("bad request", { status: 400 });
  const set = setFront(ctx.app, ctx.auth.user, next);
  return redirect("/front", {
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: set.ok
      ? { message: "The front page is updated." }
      : {
          tone: "danger",
          message: set.error.kind === "invalid" ? set.error.message : "Not yours to change.",
        },
  });
}
