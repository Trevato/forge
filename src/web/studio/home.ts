/**
 * The home in the studio: signed in, the feed — the composer, then one
 * timeline — with your apps and what is on you beside it (#599). Built from
 * the same cards as the rest of the forge, from grouped reads only, so the
 * page does not get slower as the apps grow. A stranger gets the door instead: the forge featured, then the
 * best of what is public (`actions/front.ts`).
 */

import { UPSTREAM_REPO } from "../../core/upstream.ts";
import { foundryHref } from "../../actions/foundry_door.ts";
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
import { catalog, refreshCatalogQuietly } from "../../packs/catalog.ts";
import { appsRuntime, type EnvState } from "../../apps/runtime.ts";
import { YOURE_IN_MESSAGE } from "../../actions/users.ts";
import { accountsClosedIn } from "../../core/users.ts";
import { markTold, untoldAnswer } from "../../core/requests.ts";
import { requestsCard } from "../requests_card.ts";
import { plansRow } from "../plans_row.ts";
import { freePlanName, funnelJs, noteHomeVisit } from "../funnel_door.ts";
import { publicPlans } from "../../settings/plans.ts";
import { getDoorSettings } from "../../settings/door.ts";
import { JS_FLAG_JS } from "../claim_code.ts";
import { startNameJs } from "../pages/start-forge.ts";
import { GET_A_FORGE_PATH } from "../../billing/plan_words.ts";
import { appsForRepos } from "../../core/apps.ts";
import { WEIGHT_MAX, WEIGHT_NAMES } from "../../core/front.ts";
import { LOOK_SIZES } from "../../core/looks.ts";
import { canRead, getRepo } from "../../core/repos.ts";
import { type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { activeEdgeToken, edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { repoBase, offersSignup, signInFirst, NOT_ADMIN_HERE, forbiddenPage } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page, redirect } from "../layout.ts";
import { START_REFUSALS, startRefusalIn } from "../start_refusal.ts";
import { SITE_PATH, SITE_WHAT } from "../site_line.ts";
import { siteStructuredData } from "../structured_data.ts";
import { running } from "../../kernel/version.ts";
import { homeMilestones } from "./milestone_lines.ts";
import { liveClientJs } from "../live.ts";
import {
  btn,
  card,
  dot,
  disclosure,
  empty,
  envStateBadge,
  icon,
  row,
  timeAgo,
  terminalLine,
  copyField,
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
import { interruptedOutLine } from "./interrupted_out.ts";
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
import { crewKeyCard } from "./crew_key.ts";
import { everydayCard } from "../pages/everyday.ts";
import { firstAskJs, nextStepsCard, nextStepsOf } from "../pages/next-steps.ts";
import { spawnedForge } from "../../spawn/claim.ts";
import { clientApps } from "./client_home.ts";
import { passkeyJs } from "../passkey-client.ts";

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
  const foundry = foundryHref(ctx.app, ctx.auth.user);
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
        ${foundry === undefined ? "" : btn("Foundry", { href: foundry, size: "sm", icon: "eye" })}
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
      // The figures and the week's pace open in place; alarms need the owner, so they sit under "Needs you".
      return html`${disclosure(
          "Figures",
          html`${timePhase(request, "kpis", () => kpiRow(db, kpiOpts), () => kpiCache(db))}
            ${homeWeek(ctx.app, user)}`,
          { small: true, id: "home-figures" },
        )}`;
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
  const spawned = await timePhaseAsync(ctx.request, "spawned", () => spawnedForge(ctx.app));
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
    // Before the first tell the card is the one box and carries the key line and the composer.
    const firstTell = steps.some((s) => s.key === "tell" && !s.done);
    const lean = html`<h1 class="sr-only">Home</h1>
      ${firstSteps} ${address} ${firstTell ? null : crewKeyCard(ctx)} ${heldLine(ctx, user)} ${apps}
      <div class="stack">
        ${firstTell ? null : composer(ctx, user)}
        <p class="small muted">
          <a href="/?all=1">Show everything</a>
        </p>
      </div>`;
    return page({
      ctx,
      title: "Home",
      body: lean,
      // The everyday step makes its account with a passkey (#1890).
      ...(firstSteps ? { scriptJs: firstTell ? firstAskJs : passkeyJs } : {}),
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
  // Three compartments (#10298): what needs the owner, what moved since the last look, what is live.
  const draws = homeDraws(ctx, user);
  const waiting = await homeRegion(ctx.app.db, ctx.request, user.id, "waiting", homeVariant(ctx.url), access, draws.waiting);
  const held = timePhase(ctx.request, "held", () => heldLine(ctx, user));
  const mine = writableAppsOf(ctx, user).repos;
  const stopped = timePhase(ctx.request, "stopped", () => interruptedOutLine(ctx, mine));
  const alarms = user.isAdmin
    ? alarmLines(cachedAlarms(ctx.app.db, new Date(), forgeCeiling(ctx.app.config), ctx.app.config.dataDir))
    : null;
  const visitedAt = Date.now();
  const before = timePhase(ctx.request, "visit", () =>
    isNavigation(ctx.request) ? noteVisit(ctx.app.db, user.id, visitedAt) : lastVisit(ctx.app.db, user.id),
  );
  const since = timePhase(ctx.request, "since", () => sinceYouWere(ctx.app.db, user, before, visitedAt));
  // A stranger's request for an account is the first thing that needs an admin (#10928).
  const requests = requestsCard(ctx, "home");
  // The first page after Allow says so, once.
  const allowed = untoldAnswer(ctx.app.db, user.id) === "allowed";
  if (allowed) markTold(ctx.app.db, user.id, new Date().toISOString());
  const needsYou = html`${requests}${waiting}${held}${stopped}${alarms}`;
  const body = html`<h1 class="sr-only">Home</h1>
    ${allowed ? html`<div class="toast" data-tone="success" role="status" id="youre-in"><strong>${YOURE_IN_MESSAGE}</strong> Your account is open: tell the crew what you want to build.</div>` : null}
    ${tellBox(ctx, user)}
    ${ask} ${address}
    ${when(String(needsYou).trim() !== "", () => html`<section class="stack stack-tight" id="needs-you" aria-label="Needs you"><h2 class="small muted">Needs you</h2>${needsYou}</section>`)}
    ${when(String(since).trim() !== "", () => html`<section aria-label="Since you were here">${since}</section>`)}
    <section aria-label="Live">${timePhase(ctx.request, "moving", () => movingRegion(ctx.app.db, user))}</section>
    ${homeMilestones(ctx, mine)}
    <section class="stack" aria-label="The forge">${kpis}</section>
    ${pinnedSlot(ctx.app.db, user)}
    ${appChips(ctx, user, mine)}
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
  notePhaseRest(ctx.request, "render", rendering, ["kpis", "moving", "access", "waiting", "held", "visit", "since"]);
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
        ${user.isAdmin || appRepos.length > 0 ? crewKeyCard(ctx) : null}
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

/** How many apps the door shows: the pins, then the best of the rest, with a link to all of them. */
const DOOR_TILES = 8;

/** The live address of an app a stranger may open, or nothing. */
function tileHref(entry: FrontEntry): string | undefined {
  return entry.app?.access === "public" && entry.state !== undefined
    ? `${repoBase(entry.repo)}/app/production/open`
    : undefined;
}

/** How an app is right now, in words anyone can read. */
const DOOR_STATE: Partial<Record<EnvState, string>> = {
  running: "Live now",
  asleep: "Wakes when you open it",
  deploying: "Updating",
};

/** What a stranger can do to help with an app: make an account if this forge takes new ones, or send its keepers a note. */
function helpDoor(repo: FrontEntry["repo"], accounts: boolean): Html {
  return accounts
    ? html`<a href="/signup?next=${encodeURIComponent(repoBase(repo))}">Help build</a>`
    : html`<a href="${repoBase(repo)}/report">Suggest a change</a>`;
}

/**
 * One numbered app on the door, with its doors said plainly: use it, read how
 * it is made, help with it. A featured repository may have no app and no
 * picture (the forge itself), and then has only the doors it really has.
 */
function tile(entry: FrontEntry, at: number, accounts: boolean, attrs?: Html): Html {
  const { repo, picture, state } = entry;
  const href = repoBase(repo);
  const open = tileHref(entry);
  const said = state === undefined ? undefined : DOOR_STATE[state];
  return card(
    html`<p class="door-kick"><span>${String(at + 1).padStart(2, "0")}</span>${when(said, (s) => html` / ${s}`)}</p>
      ${when(
        picture,
        (src) =>
          html`<a
            class="look"
            href="${open ?? href}"
            tabindex="-1"
            aria-hidden="true"
            ${open === undefined ? null : html`rel="nofollow"`}
            ><img
              src="${src}"
              width="${LOOK_SIZES.thumb.width}"
              height="${LOOK_SIZES.thumb.height}"
              alt=""
              loading="lazy"
              decoding="async"
          /></a>`,
      )}
      <div class="card-body stack stack-tight">
        <a href="${href}"><strong>${repo.name}</strong></a>
        <span class="muted door-line" title="${repo.description}"
          >${repo.description !== "" ? repo.description : `By ${repo.ownerName}`}</span
        >
        <p class="door-verbs">
          ${when(
            open,
            (to) => html`<a class="door-verb-first" href="${to}" rel="nofollow" aria-label="Open ${repo.name}">Open</a>`,
          )}
          <a href="${href}" aria-label="The code of ${repo.name}">Code</a>
          ${helpDoor(repo, accounts)}
        </p>
      </div>`,
    { pad: false, ...(attrs === undefined ? {} : { attrs }) },
  );
}

/** A figure in the hero's live panel, left out when it is zero. */
function doorFigure(n: number, label: string): Html | null {
  return n === 0
    ? null
    : html`<div class="door-figure">
        <strong class="num">${n.toLocaleString("en-US")}</strong>
        <span class="muted small">${label}</span>
      </div>`;
}

/**
 * The hero's live panel: what this forge's crew is doing and has just finished,
 * on public repositories only, from the front page's cached read. With nothing
 * to say it is absent and the hero stands alone: it never makes a number up.
 */
function doorLive(front: FrontPage): Html | null {
  const { pulse, total } = front;
  const figures = [
    doorFigure(total, total === 1 ? "public app" : "public apps"),
    doorFigure(pulse.running, "running now"),
    doorFigure(pulse.merged, pulse.merged === 1 ? "change in 30 days" : "changes in 30 days"),
  ].filter((f) => f !== null);
  if (figures.length === 0 && pulse.crew.running === 0 && pulse.changes.length === 0) return null;
  const agents = `${pulse.crew.running} agent${pulse.crew.running === 1 ? "" : "s"}`;
  return html`<aside class="door-live" aria-label="Right now on this forge">
    ${when(figures.length > 0, () => html`<div class="door-figures">${figures}</div>`)}
    ${when(
      pulse.crew.running > 0,
      () => html`<p class="door-now">${dot("success")}The crew is at work: ${agents} right now</p>
        ${when(
          pulse.crew.issues.length > 0,
          () => html`<ul class="door-ledger">
            ${pulse.crew.issues.map(
              (i) => html`<li><a class="truncate" href="${i.href}" title="${i.title}">${i.title}</a></li>`,
            )}
          </ul>`,
        )}`,
    )}
    ${when(
      pulse.changes.length > 0,
      () => html`<p class="door-now">Just finished</p>
        <ul class="door-ledger">
          ${pulse.changes.map(
            (c) => html`<li>
              <a class="truncate" href="${c.href}" title="${c.title}">${c.title}</a>
              <span class="muted small door-when">${c.repo} · ${timeAgo(c.mergedAt)}</span>
            </li>`,
          )}
        </ul>`,
    )}
  </aside>`;
}

/**
 * The work itself as a picture: one bar for each of the last days, as tall as
 * the changes finished that day. Absent until there is any. Each bar names its
 * day and count on hover, so nothing needs a script.
 */
function doorPulse(days: FrontPage["pulse"]["days"]): Html | null {
  const total = days.reduce((sum, d) => sum + d.n, 0);
  if (total === 0) return null;
  const peak = Math.max(...days.map((d) => d.n));
  const height = 120;
  return html`<figure class="door-pulse">
    <svg
      viewBox="0 0 ${days.length * 10} ${height}"
      preserveAspectRatio="none"
      role="img"
      aria-label="${total} changes finished in ${days.length} days, at most ${peak} in one day"
    >
      ${days.map((d, at) => {
        // A quiet day still holds its place on the baseline.
        const h = d.n === 0 ? 1 : Math.max(3, Math.round((d.n / peak) * height));
        return html`<rect
          class="${d.n === 0 ? "door-pulse-quiet" : ""}"
          x="${at * 10 + 1}"
          y="${height - h}"
          width="8"
          height="${h}"
          ><title>${d.day}: ${d.n}</title></rect
        >`;
      })}
    </svg>
    <figcaption class="muted small">
      Every bar is one day of finished work here: ${total.toLocaleString("en-US")} changes in ${days.length} days.
    </figcaption>
  </figure>`;
}

const FORGE_REPO = UPSTREAM_REPO;

/**
 * One press for each shipped pack (#9572): what it is, and the way to its page,
 * where the command is. The `data-slot="host"` element is the named place a
 * later "host it for me" action sits beside "See what it brings"; it is empty
 * today, so there is no dead button.
 */
function packPresses(): Html | null {
  const { packs } = catalog();
  if (packs.length === 0) return null;
  const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
  return html`<div class="door-packs" aria-label="Ready-made forges">
    <p class="door-kick">Start from a ready-made forge</p>
    <div class="door-press-row">
      ${packs.map(
        (p) => html`<article class="door-press">
          <h3><a href="/packs/${p.name}">${p.title}</a></h3>
          <p class="muted small">${p.description}</p>
          <p class="muted small">${count(p.apps.length, "app")}, ${count(p.crew.length, "crew member")}</p>
          <div class="door-press-actions">
            ${btn("See what it brings", { href: `/packs/${p.name}`, size: "sm" })}
            <span data-slot="host"></span>
          </div>
        </article>`,
      )}
    </div>
  </div>`;
}

/** The page the prompt and the Open in ChatGPT, Claude and Grok links send an assistant to. */
const AGENTS = "/agents";

/**
 * What a person pastes into any AI assistant. It asks for help and says what
 * to do when the assistant cannot reach the forge, which a hosted one often
 * cannot.
 */
function agentPrompt(origin: string): string {
  return `Read ${origin}${AGENTS} and tell me in plain words what this forge is. Ask if I want to help build one of its public apps or get my own forge, then walk me through it. If you can't open the link or act on the forge yourself, say so and give me the exact steps.`;
}

/**
 * The studio's door for a stranger (#686): what this is, what it is doing right
 * now, what it has made, and how to get one, each door saying in plain words
 * what it does. The site's pins lead the apps, in their order, and the best
 * of what is public fills the rest (`actions/front.ts` decides all of it, and
 * the API and MCP answer from the same place). A signed-out reader gets this
 * whatever the mode, with a visitor's top bar and foot.
 *
 * `/front` is the same page for anyone; a site admin there also gets the
 * controls that decide it.
 */
export function studioDoor(ctx: Ctx): Response {
  // A refused start lands back here: one fixed sentence for why, and the name still in its field.
  const refusal = startRefusalIn(ctx.url.searchParams.get("start"));
  const keptName = refusal === undefined ? "" : (ctx.url.searchParams.get("name") ?? "").slice(0, 39);
  // The door draws what is in memory; a pack pushed since is picked up for the next visit.
  void refreshCatalogQuietly(ctx.app, 5_000);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let tiles: Html[] = [];
  const front = timePhase(ctx.request, "shelf", () => frontPage(ctx.app, Date.now(), ctx.request));
  const featured = front.featured;
  const all = [...(featured === undefined ? [] : [featured]), ...front.shelf];
  const made = all.slice(0, Math.max(DOOR_TILES, all.filter((e) => e.pinned).length));
  const { mode, plans: allPlans, links } = getDoorSettings(ctx.app.db);
  const accounts = !accountsClosedIn(ctx.app.db, mode);
  timePhase(ctx.request, "tiles", () => {
    tiles = made.map((e, at) =>
      tile(e, at, accounts, e === featured ? html`role="region" aria-label="Featured"` : undefined),
    );
  });
  // Render is what is left of the page once the shelf read is taken out.
  const rendering = performance.now();
  const visitor = ctx.auth.user === undefined;
  // The funnel's first step: a stranger at the home (#11259), no SQL here.
  if (visitor && ctx.url.pathname === "/" && ctx.request.method === "GET") noteHomeVisit(ctx);
  const admin = ctx.auth.user?.isAdmin === true && ctx.url.pathname === "/front";
  // A share sheet lands here with the shared words in the query; signing in
  // comes back to them rather than to a bare home, so they are not lost.
  const back = ctx.url.pathname === "/" ? "/" + ctx.url.search : "/";
  const nextQuery = back === "/" ? "" : `?next=${encodeURIComponent(back)}`;
  const ssh = sshCommand(ctx.app);
  const signup = offersSignup(ctx) && accounts;
  // Closed is a door with nothing behind it; invite still lands an invite link's holder.
  const origin = (ctx.app.config.url ?? ctx.url.origin).replace(/\/$/, "");
  const prompt = agentPrompt(origin);
  const asked = encodeURIComponent(prompt);
  const body = html`<div class="door">
    <section class="door-hero">
      <h1>Software for what you're building.<br /><span class="muted">Yours to keep.</span></h1>
      <div class="door-under">
        <div class="door-lead">
          <p class="door-support">Say what you need and an AI crew builds it in your own forge, free to try.</p>
          <form method="post" action="/forges/start" class="door-start" id="start-forge" data-js>
            ${refusal === undefined ? null : html`<p class="error" id="start-refused">${START_REFUSALS[refusal]}</p>`}
            <div class="field">
              <label for="start-name">Forge name</label>
              <input class="input" id="start-name" name="name" type="text" value="${keptName}" aria-describedby="${refusal === undefined ? "start-name-says" : "start-refused start-name-says"}" ${refusal === undefined ? null : html`aria-invalid="true"`} required autocomplete="off" autocapitalize="none" spellcheck="false" />
              <p class="muted small door-says" id="start-name-says" role="status" aria-live="polite"></p>
            </div>
            ${btn("Start my forge", { variant: "primary", size: "lg" })}
          </form>
          ${when(made.length > 0, () => html`<div class="bar">${btn("See what it built", { href: "#made", size: "lg" })}</div>`)}
          <div class="door-agent">
            <p>
              Have an AI assistant? Give it this:
              <a href="https://chatgpt.com/?q=${asked}" rel="noopener">Open in ChatGPT</a>
              <a href="https://grok.com/?q=${asked}" rel="noopener">Open in Grok</a>
              <a href="https://claude.ai/new?q=${asked}" rel="noopener">Open in Claude</a>
              <span class="muted">(after you sign in)</span>
            </p>
            ${copyField("door-prompt", prompt, "A message for any AI assistant", "Copy the message")}
          </div>
        </div>
        ${doorLive(front)}
      </div>
      ${doorPulse(front.pulse.days)}
    </section>

    <section class="door-section" id="made">
      <h2>Made here</h2>
      <p class="door-support">
        A tool for your business, a game for your studio. Open runs it in your browser. Code shows how it was
        made.
        ${accounts
          ? "Help build gets you an account, so you can ask for changes."
          : "Suggest a change sends a note to the people who keep it."}
      </p>
      ${made.length > 0
        ? html`<div class="door-shelf" data-shelf>${tiles}</div>
            ${when(
              front.total > made.length,
              () => html`<p class="door-more">
                <a href="/explore?q=kind%3Aapp">All ${front.total} public apps</a>
              </p>`,
            )}`
        : html`<div class="mt">
            ${empty({
              icon: "rocket",
              title: "Nothing public is up yet",
              note: "Apps made public here show up on this shelf once they run.",
            })}
          </div>`}
    </section>

    <section class="door-section">
      <h2>From a sentence to something you can use</h2>
      <ol class="door-steps">
        <li>
          <h3>Describe it</h3>
          <p>Say what you want in plain words: a fix, a new feature, a whole game, the tool your shop is missing.</p>
        </li>
        <li>
          <h3>Try it</h3>
          <p>An AI agent builds it on a separate copy. You click around a live preview while nothing else changes.</p>
        </li>
        <li>
          <h3>Ship it</h3>
          <p>It goes live when you say so, or set it to ship by itself. Every change is kept.</p>
        </li>
      </ol>
    </section>

    <section class="door-section">
      <h2>It stays yours</h2>
      <dl class="door-points">
        <div>
          <dt>You can move it</dt>
          <dd>Your code is in git and everything else is in one SQLite file. Copy them to any machine and keep going.</dd>
        </div>
        <div>
          <dt>The crew is private</dt>
          <dd>The agents work for your forge alone, on your projects, with your own AI account.</dd>
        </div>
        <div>
          <dt>Forges connect</dt>
          <dd>Bring an app in from another forge, do your work, and send it back to where it came from.</dd>
        </div>
      </dl>
      <ul class="door-proof">
        <li>one Bun process</li>
        <li>one SQLite file</li>
        <li>MCP at /mcp</li>
        <li>AGPL-3.0</li>
      </ul>
    </section>

    <div class="door-section">${homeMilestones(ctx)}</div>

    <section class="door-section" id="yours">
      <div class="stack">
        <h2>Get your own forge</h2>
        <p class="door-support">
          Hosted for you, or free and open source on a machine you keep.
        </p>
        ${plansRow(publicPlans(allPlans), links)}
        <div class="bar" data-plan="${freePlanName(allPlans)}">${btn("Get a forge", { href: visitor ? "#start-forge" : GET_A_FORGE_PATH, variant: "primary", size: "lg" })}</div>
        <p class="door-support">Or run it yourself, free and open source: <a href="${FORGE_REPO}">read the step-by-step guide</a>.</p>
        <pre class="door-code"><code>git clone ${FORGE_REPO}.git
cd forge
bun install
bun run src/main.ts</code></pre>
        ${when(
          ssh,
          (command) => html`<div class="stack-tight">
            ${terminalLine({ command }, ctx.app.config.sshHostKey)}
            <p class="muted small">Or visit this forge from your terminal: your key is your identity, and the host key above is yours to check.</p>
          </div>`,
        )}
        ${packPresses()}
      </div>
    </section>
    <p class="door-org">
      Running this for a team? <a href="https://www.open-platform.sh/#platform">The Platform</a> runs on your own cloud, and
      <a href="https://www.espodev.com">EspoDev</a> delivers enterprise implementations.
    </p>
    ${when(admin, () => html`<div class="door-section front-admin">${frontControls(ctx, front)}</div>`)}
  </div>`;
  const res = page({
    ctx,
    title: "Open Platform Forge: software for what you're building, yours to keep",
    description: `${SITE_WHAT} ${SITE_PATH(origin)}`,
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${funnelJs}\n${startNameJs}\n${JS_FLAG_JS}`,
    jsonLd: siteStructuredData(origin, running().version),
    ...(visitor
      ? {
          tools: html`<a class="small door-wide" href="#made">Made here</a>
            <a class="small" href="/pricing">Pricing</a>
            <a class="small door-wide" href="${FORGE_REPO}">Code</a>
            ${signup
              ? html`<a class="small" href="/signin${nextQuery}">Sign in</a>
                ${btn("Create an account", { href: `/signup${nextQuery}` })}`
              : html`${when(mode !== "closed", () => html`<a class="small door-wide" href="/signup">Create an account</a>`)}
                ${btn("Sign in", { href: activeEdgeToken(ctx.app) === undefined ? `/signin${nextQuery}` : edgeLoginUrl(back) })}`}`,
          foot: html`<span class="mark"></span>
            <span>Open Platform: two open source projects, AGPL-3.0</span>
            <span class="spacer"></span>
            <a href="${FORGE_REPO}">Code</a>
            <a href="https://www.open-platform.sh">open-platform.sh</a>
            <a href="https://www.espodev.com">EspoDev</a>`,
        }
      : {}),
  });
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
