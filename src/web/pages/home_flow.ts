/**
 * The new home: what the forge is doing right now, on one screen. The
 * pipeline is the page: six lanes (asked, building, checks, review, landing,
 * live), each a live region of compact tiles with its own count and health in
 * words, so one event redraws one lane and a tile moves between lanes as the
 * work does. Above them a thin strip of the few figures that matter today and,
 * only when something truly needs the owner, one line. Below, the hosted
 * forges in one line.
 *
 * Nothing here polls, and nothing here reads the database to draw. Every
 * region is a `data-live` region of the one stream every page holds
 * (`liveRegionsJs`) and is drawn from the lane picture (`flow/lanes.ts`),
 * which a worker reads and the thread keeps: a page or a lane is a memory
 * read, and a lane that has not changed answers 304 from the picture's
 * version without being drawn. The page is a static picture with scripts off.
 */

import type { App } from "../../app.ts";
import { usd } from "../../core/money.ts";
import { listChildren } from "../../actions/spawn.ts";
import { lastHeard, MAX_CHILDREN, QUIET_MS } from "../../spawn/heartbeat.ts";
import { isAwakeBody } from "../../spawn/host.ts";
import { sparkline } from "../studio/kpi_row.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";
import { hoursWords } from "../../flow/lead_time.ts";
import {
  LANES,
  LANE_HOLDS,
  LANE_NAME,
  lanePicture,
  warmLanes,
  laneHealth,
  viewFor,
  type Health,
  type LaneKey,
  type LanePicture,
  type LaneView,
  type PictureOptions,
  type StripPart,
} from "../../flow/lanes.ts";
import { span } from "../../flow/pipeline.ts";
import { lastProof, proofNeed, type Proof } from "../../release/prove.ts";
import { running, UNSTAMPED } from "../../kernel/version.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import { homeFlowJs } from "./home_flow_client.ts";
import { liveRegionsJs } from "../client.ts";
import { html, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { BOOTED } from "../../release/gate.ts";
import { nowHref } from "./now.ts";
import { secureFor } from "../../http/cookie_secure.ts";
import { cookieValue } from "../../http/context.ts";
import { parseTable, tableParams, tableRows, type TableQuery } from "../../flow/lanes_table.ts";
import { TABLE_LIVE, tableRegion, tableTag, tableTools } from "./home_table.ts";

/** The median as a person says it: minutes under an hour, else hours. */
const leadWords = (h: number): string => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : hoursWords(h));

/** The events that can move work between lanes, per lane. A burst of them is one fetch of the lane. */
const LANE_LIVE: Record<LaneKey, string> = {
  asked: "issue.opened,issue.closed,issue.reopened,issue.blocked,issue.unblocked,run.queued,run.started,run.finished",
  building: "run.queued,run.started,run.finished,pull.opened,pull.closed",
  checks: "run.queued,run.started,run.finished,pull.opened,pull.pushed,pull.merged",
  review: "run.queued,run.started,run.finished,pull.reviewed,pull.closed,pull.merged",
  landing: "pull.reviewed,pull.merged,pull.closed,pull.pushed,queue.*,run.finished,app.serving",
  live: "app.serving,release.*,run.finished,run.started,pull.merged",
};
const STRIP_LIVE = "pull.merged,run.finished,release.*,app.serving,app.stopped,forge.*,queue.*";
const FORGES_LIVE = "forge.*";

/** An `owner/name` the filter may hold; anything else is no filter. */
const APP_SLUG = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

const filterOf = (url: URL): string | null => {
  const v = url.searchParams.get("app") ?? "";
  return APP_SLUG.test(v) ? v : null;
};

const query = (only: string | null): string => (only === null ? "" : `&app=${encodeURIComponent(only)}`);

/** A stretch of time as a clock the page keeps: the words the server uses, redrawn by the page's script on any event. */
function age(iso: string, now: number): Html {
  const at = Date.parse(iso);
  return html`<time class="hf-age" datetime="${new Date(at).toISOString()}">${span(now - at)}</time>`;
}

const TONE_WORD = {
  quiet: "Quiet",
  flowing: "Flowing",
  waiting: "Waiting",
  stuck: "Stuck",
} as const;
const TONE_DOT = {
  quiet: "default",
  flowing: "success",
  waiting: "attn",
  stuck: "danger",
} as const;

function tile(i: LaneView["items"][number], now: number): Html {
  const no =
    i.number === null
      ? null
      : html` <span class="tile-no">#${String(i.number)}</span>`;
  return html`<li class="tile" data-key="${i.key}" data-state="${i.state}">
    <a
      class="tile-link"
      href="${i.href}"
      title="${i.repo}${i.number === null ? "" : ` #${i.number}`}: ${i.title}"
    >
      <span class="tile-top"
        ><span class="tile-app">${i.repo.split("/")[1] ?? i.repo}${no}</span
        ><span class="tile-clock">${age(i.since, now)}</span></span
      >
      <span class="tile-title">${i.title}</span>
      <span class="tile-hint"
        >${i.who === ""
          ? ""
          : html`<span class="tile-who">${i.who}</span> · `}${i.hint}</span
      >
    </a>
  </li>`;
}

/** Where a lane's overflow opens: the admin's list of what the lane counts, else the board. */
function moreHref(key: LaneKey, admin: boolean): string {
  if (!admin) return "/board";
  if (key === "checks") return nowHref("check");
  if (key === "review") return nowHref("review");
  if (key === "landing") return nowHref("land");
  if (key === "live") return nowHref("live");
  return key === "asked" ? "/asked" : "/board";
}

/** One lane: a live region that answers for itself (`/live/lane`), so an event redraws this lane and no other. */
export function laneRegion(
  view: LaneView,
  health: Health,
  only: string | null,
  admin: boolean,
  now: number,
): Html {
  const key = view.key;
  const shown = view.items.length;
  const rest = Math.max(0, view.total - shown);
  const md = Math.max(0, view.total - Math.min(shown, 4));
  const sm = Math.max(0, view.total - Math.min(shown, 1));
  const label = `${LANE_NAME[key]}: ${view.total}. ${health.words}`;
  const scope = only === null ? null : html` data-live-repo="${only}"`;
  return html`<section
    class="lane"
    id="lane-${key}"
    data-lane="${key}"
    data-tone="${health.tone}"
    data-count="${String(view.total)}"
    aria-label="${label}"
    data-live="${LANE_LIVE[key]}"
    data-live-src="/live/lane?s=${key}${query(only)}"
    ${scope}
  >
    <header class="lane-head">
      <h2 class="lane-name"><a class="lane-name-link" href="${moreHref(key, admin)}" title="${LANE_HOLDS[key]}">${LANE_NAME[key]}</a></h2>
      <span class="lane-count num" aria-hidden="true"
        >${String(view.total)}</span
      >
    </header>
    <p class="lane-health">
      <span class="lane-state"
        ><span
          class="dot"
          ${TONE_DOT[health.tone] === "default"
            ? null
            : html`data-tone="${TONE_DOT[health.tone]}"`}
        ></span
        >${TONE_WORD[health.tone]}</span
      >
      ${health.words}
    </p>
    ${shown === 0
      ? null
      : html`<ol class="lane-list">
          ${view.items.map((i) => tile(i, now))}
        </ol>`}
    ${sm === 0
      ? null
      : html`<p class="lane-more">
          <a href="${moreHref(key, admin)}"
            ><span class="lane-more-lg">${rest === 0 ? "" : `${rest} more${key === "asked" ? " ready" : ""}`}</span
            ><span class="lane-more-md">${md === 0 ? "" : `${md} more${key === "asked" ? " ready" : ""}`}</span
            ><span class="lane-more-sm">${sm === 0 ? "" : `${sm} more${key === "asked" ? " ready" : ""}`}</span></a
          >
        </p>`}
  </section>`;
}


/** What the lanes' reading needs of the forge. */
const pictureOptions = (app: App): PictureOptions => ({ dataDir: app.config.dataDir, ceilingUsd: forgeCeiling(app.config) });
const optionsOf = (ctx: Ctx): PictureOptions => pictureOptions(ctx.app);

const healthOf = (view: LaneView, picture: LanePicture, now: number): Health => laneHealth(view, { now, builders: picture.builders, moved: picture.moved });

// ---- the strip: today's figures, and the one line that needs the owner ----

function fig(label: string, value: Html | string, note: Html | string, href: string, extra: Html | null = null, tone: "attn" | null = null): Html {
  return html`<a class="hf-fig" href="${href}" ${tone === null ? null : html`data-tone="${tone}"`}>
    <span class="hf-fig-label">${label}</span>
    <span class="hf-fig-value num">${value}</span>
    <span class="hf-fig-note">${note}</span>
    ${extra === null ? null : html`<span class="hf-fig-spark">${extra}</span>`}
  </a>`;
}

function proofWords(proof: Proof | undefined, version: string): { text: string; tone: "attn" | null } {
  if (proof === undefined) return { text: "not proven yet", tone: null };
  if (proof.version !== version) return { text: "proof running", tone: null };
  return proof.ok ? { text: "journey proof passed", tone: null } : { text: "journey proof failed", tone: "attn" };
}

/**
 * The week the figure shows: the provider's own meter when it has reported
 * one, else the forge's own estimate, said as one ("about"): the crew's
 * seven days at list price, against seven days of the daily ceiling when the
 * forge has one.
 */
function weekFigure(strip: StripPart): { value: string; note: string; attn: boolean } {
  const w = strip.week;
  if (w !== null) return { value: `${w.usedPct}%`, note: `of the crew's week; it may use ${w.mayUsePct}%`, attn: w.usedPct >= w.mayUsePct };
  if (strip.ceilingUsd !== null && strip.ceilingUsd > 0) {
    const pct = Math.round((strip.weekSpendUsd / (strip.ceilingUsd * 7)) * 100);
    return { value: `about ${pct}%`, note: "the provider has not reported its week; this is the crew's seven days at list price against seven days of the daily ceiling", attn: pct >= 100 };
  }
  return { value: strip.weekSpendUsd < 1 ? "about $0" : `about ${usd(strip.weekSpendUsd)}`, note: "spent by the crew in seven days, at list price; the provider has not reported its week", attn: false };
}

/** The strip: five figures, each with its unit and, where the data has one, a trend; and the one line that needs the owner. */
export function stripRegion(picture: LanePicture, dataDir: string, now: number): Html {
  const strip = picture.strip;
  const version = running().version;
  const proof = proofWords(lastProof(dataDir), version);
  const unproven = proofNeed(dataDir, version);
  const needs = [...(unproven === undefined ? [] : [{ says: unproven.sentence, href: "/releases" }]), ...(strip?.needs ?? [])];
  const need = needs[0];
  const others = needs.length - 1;
  const b = picture.builders;
  const week = strip === null ? null : weekFigure(strip);
  return html`<section class="hf-strip" id="hf-strip" aria-label="Today's figures" data-live="${STRIP_LIVE}" data-live-src="/live/strip">
    ${need === undefined
      ? html`<p class="hf-calm"><span class="dot" data-tone="success"></span>Nothing needs you right now.</p>`
      : html`<p class="hf-need" role="status"><span class="dot" data-tone="danger"></span><a href="${need.href}">${need.says}</a>${others > 0 ? html` <a class="hf-need-more" href="/boards">and ${String(others)} more</a>` : null}</p>`}
    <div class="hf-figs">
      ${fig("Shipped in 24 hours", strip === null ? "—" : String(strip.landed), strip?.landed === 1 ? "change landed on main" : "changes landed on main", "/board", strip === null ? null : sparkline(strip.landedHours))}
      ${fig("Median open to landed", strip === null || strip.lead.medianHours === null ? "—" : leadWords(strip.lead.medianHours), strip === null || strip.lead.medianHours === null ? "nothing landed in 24 h" : `median of ${strip.lead.landed} ${strip.lead.landed === 1 ? "change" : "changes"}, 24 h`, "/boards")}
      ${fig("Crew running", b.slots === 0 ? String(b.running) : `${b.running} of ${b.slots}`, b.slots === 0 ? "no builder slots set" : "builders at work now", "/settings/crew")}
      ${fig("Week used", week === null ? "—" : week.value, week === null ? "the week is not read yet" : week.note, "/settings/crew", null, week?.attn === true ? "attn" : null)}
      ${fig("Live version", version === UNSTAMPED ? "—" : version, html`live <time class="hf-age-ago" datetime="${BOOTED}">${span(now - Date.parse(BOOTED))}</time> · ${proof.text}`, "/releases", null, proof.tone)}
    </div>
  </section>`;
}

// ---- before the first reading: the same regions, saying so ----

/** A lane before the picture exists: its name, "reading…", and the address that fills it. The page's script fetches that address at once. */
function readingLane(key: LaneKey, only: string | null, admin: boolean): Html {
  const scope = only === null ? null : html` data-live-repo="${only}"`;
  return html`<section class="lane" id="lane-${key}" data-lane="${key}" data-tone="quiet" data-count="" data-reading aria-busy="true"
    data-live="${LANE_LIVE[key]}" data-live-src="/live/lane?s=${key}${query(only)}"${scope}>
    <header class="lane-head">
      <h2 class="lane-name"><a class="lane-name-link" href="${moreHref(key, admin)}" title="${LANE_HOLDS[key]}">${LANE_NAME[key]}</a></h2>
      <span class="lane-count num" aria-hidden="true">…</span>
    </header>
    <p class="lane-health">Reading what the forge is doing…</p>
  </section>`;
}

const readingStrip = (): Html =>
  html`<section class="hf-strip" id="hf-strip" data-reading aria-busy="true" aria-label="Today's figures" data-live="${STRIP_LIVE}" data-live-src="/live/strip"><p class="hf-calm"><span class="dot"></span>Reading today's figures…</p></section>`;

const readingTable = (q: TableQuery): Html => {
  const params = tableParams(q);
  return html`<section class="tb-region" id="hf-table" data-reading aria-busy="true" data-live="${TABLE_LIVE}" data-live-src="/live/table${params === "" ? "" : `?${params}`}"><p class="tb-empty">Reading what the forge is doing…</p></section>`;
};

// ---- hosted forges, in one line ----

interface Forges {
  readonly at: number;
  readonly total: number;
  readonly awake: number;
  readonly quiet: readonly string[];
}
const forgesKept = new WeakMap<App, Forges>();
const forgesReading = new WeakMap<App, Promise<Forges | undefined>>();
const FORGES_REUSE_MS = process.env["NODE_ENV"] === "test" ? 0 : 20_000;

/**
 * The hosted forges as the ledgers and the last heartbeats say: every file is
 * read at once (on a cold disk a hundred small reads one after another were
 * 1.6 s), and awake is a look at what this process holds open, never a read.
 * One reading at a time; it is started after a response or at boot, never
 * waited for by a page.
 */
function readForges(app: App, now: number): Promise<Forges | undefined> {
  const going = forgesReading.get(app);
  if (going !== undefined) return going;
  const reading = (async (): Promise<Forges | undefined> => {
    const children = await listChildren(app);
    const listed = children.slice(0, MAX_CHILDREN);
    const heard = await Promise.all(listed.map((c) => lastHeard(app, c.name)));
    const awake = listed.flatMap((c, i) => (isAwakeBody(app, c.bodyId) ? [{ name: c.name, heard: heard[i] }] : []));
    // An awake forge that has stopped reporting to this one is the one worth a name.
    const quiet = awake.filter((c) => c.heard !== undefined && now - c.heard.receivedAt > QUIET_MS).map((c) => c.name);
    const out: Forges = { at: now, total: children.length, awake: awake.length, quiet };
    forgesKept.set(app, out);
    return out;
  })().catch(() => undefined).finally(() => forgesReading.delete(app));
  forgesReading.set(app, reading);
  return reading;
}

/** Start reading the hosted forges now: the forge calls this once it is listening. */
export function warmHome(app: App): void {
  if (process.env["NODE_ENV"] === "test") return;
  warmLanes(app.db, pictureOptions(app), Date.now());
  void readForges(app, Date.now());
}

function forgesHtml(f: Forges): Html {
  const words =
    f.total === 0
      ? "No hosted forges yet."
      : `${f.total} hosted ${f.total === 1 ? "forge" : "forges"}: ${f.awake} awake, ${f.total - f.awake} asleep (a sleeping forge wakes when someone opens it). ${f.quiet.length === 0 ? "None is stuck." : `${f.quiet.join(", ")} ${f.quiet.length === 1 ? "is" : "are"} awake but not reporting.`}`;
  return html`<p class="hf-forges" id="hf-forges" data-live="${FORGES_LIVE}" data-live-src="/live/forges" data-tone="${f.quiet.length === 0 ? "ok" : "attn"}"><span class="dot" ${f.quiet.length === 0 ? null : html`data-tone="attn"`}></span><a href="/forges">${words}</a></p>`;
}

const readingForges = (): Html =>
  html`<p class="hf-forges" id="hf-forges" data-reading data-live="${FORGES_LIVE}" data-live-src="/live/forges"><span class="dot"></span><span>Reading the hosted forges…</span></p>`;

/**
 * The hosted forges' line from the last reading, never a probe on a request:
 * older than 20 s, a new reading starts behind it; before any, the line says
 * it is reading and the page's script fetches it. A fragment (`wait`) waits
 * for the reading, off the thread. `bun test` waits, so a test reads what it wrote.
 */
export async function forgesRegion(app: App, wait: boolean): Promise<Html> {
  const now = Date.now();
  const kept = forgesKept.get(app);
  if (kept === undefined) {
    const reading = readForges(app, now);
    if (!wait && process.env["NODE_ENV"] !== "test") return readingForges();
    const f = await reading;
    return f === undefined ? readingForges() : forgesHtml(f);
  }
  if (now - kept.at >= FORGES_REUSE_MS) {
    const reading = readForges(app, now);
    if (process.env["NODE_ENV"] === "test") return forgesHtml((await reading) ?? kept);
  }
  return forgesHtml(kept);
}

// ---- the page ----

/** The filter: a select whose other apps are read from `data-apps` by the page's script when it is opened, so no list of them is written out as text. Without scripts, an app's `owner/name` is typed. */
function filterForm(repos: readonly string[], only: string | null): Html {
  return html`<form class="hf-filter" method="get" action="/home" id="hf-filter">
    <label class="hf-filter-label" for="hf-app">Show</label>
    <select class="input" id="hf-app" aria-label="Show one app, or everything" data-apps="${repos.join(",")}">
      <option value="" ${only === null ? html`selected` : null}>Every app (${String(repos.length)})</option>
      ${only === null ? null : html`<option value="${only}" selected>${only}</option>`}
    </select>
    <noscript><input class="input" name="app" placeholder="owner/name" aria-label="An app, as owner/name" /><button class="btn" type="submit">Show</button></noscript>
  </form>`;
}

/** Which view: the one the address asks for (and then remembers), else the one remembered, else the lanes. */
function viewOf(ctx: Ctx): { view: "lanes" | "table"; asked: boolean } {
  const asked = ctx.url.searchParams.get("view");
  if (asked === "lanes" || asked === "table") return { view: asked, asked: true };
  return { view: cookieValue(ctx.request, VIEW_COOKIE) === "table" ? "table" : "lanes", asked: false };
}
const VIEW_COOKIE = "forge_home_view";

/** The Lanes | Table switch: two links, each an address of its own, the app filter carried across. */
function viewSwitch(view: "lanes" | "table", only: string | null): Html {
  const keep = only === null ? "" : `&app=${encodeURIComponent(only)}`;
  return html`<nav class="hf-views" aria-label="View">
    <a href="/home?view=lanes${keep}" ${view === "lanes" ? html`aria-current="page"` : null}>Lanes</a>
    <a href="/home?view=table${keep}" ${view === "table" ? html`aria-current="page"` : null}>Table</a>
  </nav>`;
}

// GET /home — the new home: the lanes, or the table of the same items.
export async function homeFlowPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const { view, asked } = viewOf(ctx);
  const only = filterOf(ctx.url);
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "page", now));
  const rendering = performance.now();
  const viewing = picture === undefined ? undefined : timePhase(ctx.request, "viewing", () => viewFor(ctx.app.db, user, picture, view === "table" ? null : only));
  const strip = !user.isAdmin ? null : picture === undefined ? readingStrip() : stripRegion(picture, ctx.app.config.dataDir, now);
  const forges = user.isAdmin ? await timePhaseAsync(ctx.request, "forges", () => forgesRegion(ctx.app, false)) : null;
  let main: Html;
  const q = parseTable(ctx.url.searchParams);
  if (picture === undefined || viewing === undefined) {
    main = view === "table" ? html`${tableTools(q)}${readingTable(q)}` : html`<div class="hf-lanes">${LANES.map((k) => readingLane(k, only, user.isAdmin))}</div>`;
  } else if (view === "table") {
    main = html`${tableTools(q)}${tableRegion(tableRows(viewing, tableInput(picture, now)), q, now)}`;
  } else {
    main = html`<div class="hf-lanes">${LANES.map((k) => laneRegion(viewing.lanes[k], healthOf(viewing.lanes[k], picture, now), only, user.isAdmin, now))}</div>`;
  }
  const body = html`<div class="hf" id="hf" data-view="${view}">
    <header class="hf-head">
      <div class="hf-title">
        <h1>Your forge, right now</h1>
        <p class="hf-live muted" id="hf-live" data-state="connecting"><span class="dot"></span><span class="hf-live-text">Updates as it happens</span></p>
      </div>
      ${viewSwitch(view, only)}
      ${view === "lanes" ? filterForm(viewing?.repos ?? [], only) : null}
    </header>
    ${strip}
    ${main}
    ${forges}
    <p class="hf-foot small muted">
      <span>${view === "table" ? "Every item of every lane, one row each; sort, filter and search are in the address, so a link is a view." : "Each lane is a step a change takes; a tile moves on by itself when its work does."}</span>
      <a href="/?home=classic">The classic home</a>
      <a href="/feed">The feed</a>
    </p>
  </div>`;
  const res = page({ ctx, title: "Home", body, wide: true, scriptJs: `${liveRegionsJs}\n${homeFlowJs}` });
  // The view asked for in the address is remembered for the next visit.
  if (asked) {
    const secure = secureFor(ctx.url, ctx.app.config.url) ? "; Secure" : "";
    res.headers.append("set-cookie", `${VIEW_COOKIE}=${view}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
  }
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

/** What the rows' states read besides the rows. */
const tableInput = (picture: LanePicture, now: number) => ({ now, builders: picture.builders, moved: picture.moved });

// GET /live/table?<view> — the table's rows alone, for the region that shows them; an unchanged table answers 304 without being drawn.
export async function liveTableFragment(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const q = parseTable(ctx.url.searchParams);
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "lane", now));
  const rendering = performance.now();
  if (picture === undefined) return fragment(readingTable(q), { request: ctx.request });
  const tag = tableTag(picture, user.isAdmin ? "admin" : user.id, q, now);
  if (ctx.request.headers.get("if-none-match") === `"${tag}"`) {
    notePhase(ctx.request, "render", performance.now() - rendering);
    return new Response(null, { status: 304, headers: { etag: `"${tag}"`, "cache-control": "no-store" } });
  }
  const viewing = timePhase(ctx.request, "viewing", () => viewFor(ctx.app.db, user, picture, null));
  const res = fragment(tableRegion(tableRows(viewing, tableInput(picture, now)), q, now), { request: ctx.request, etag: tag });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

/** A lane's ETag: the picture's version of the lane and what else its words read, for this viewer and this filter, and the minute (its ages are in minutes). A lane that has not changed answers 304 without being drawn. */
function laneTag(picture: LanePicture, key: LaneKey, viewer: string, only: string | null, now: number): string {
  const b = picture.builders;
  return Bun.hash(`${picture.versions[key]}|${picture.moved[key]}|${b.running}/${b.slots}|${viewer}|${only ?? ""}|${Math.floor(now / 60_000)}`).toString(36);
}

// GET /live/lane?s=<lane>[&app=owner/name] — one lane alone, for the region that shows it.
export async function liveLaneFragment(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  const key = LANES.find((k) => k === ctx.url.searchParams.get("s"));
  if (user === undefined || key === undefined) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const only = filterOf(ctx.url);
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "lane", now));
  const rendering = performance.now();
  if (picture === undefined) return fragment(readingLane(key, only, user.isAdmin), { request: ctx.request });
  const tag = laneTag(picture, key, user.isAdmin ? "admin" : user.id, only, now);
  if (ctx.request.headers.get("if-none-match") === `"${tag}"`) {
    notePhase(ctx.request, "render", performance.now() - rendering);
    return new Response(null, { status: 304, headers: { etag: `"${tag}"`, "cache-control": "no-store" } });
  }
  const viewing = timePhase(ctx.request, "viewing", () => viewFor(ctx.app.db, user, picture, only));
  const view = viewing.lanes[key];
  const res = fragment(laneRegion(view, healthOf(view, picture, now), only, user.isAdmin, now), { request: ctx.request, etag: tag });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// GET /live/strip — the figures and the one line, alone.
export async function liveStripFragment(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined || !user.isAdmin) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "lane", now));
  const rendering = performance.now();
  const res = fragment(picture === undefined ? readingStrip() : stripRegion(picture, ctx.app.config.dataDir, now), { request: ctx.request });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// GET /live/forges — the hosted forges' line, alone.
export async function liveForgesFragment(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined || !user.isAdmin) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const rendering = performance.now();
  const res = fragment(await timePhaseAsync(ctx.request, "forges", () => forgesRegion(ctx.app, true)), { request: ctx.request });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}
