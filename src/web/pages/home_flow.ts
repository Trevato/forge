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
import { listChildren } from "../../actions/spawn.ts";
import { lastHeard, MAX_CHILDREN, QUIET_MS } from "../../spawn/heartbeat.ts";
import { isAwakeBody } from "../../spawn/host.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";
import { count, duration, money } from "../../flow/figure_format.ts";
import { waitingWords } from "../../flow/kpi_words.ts";
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
import { lastProof, proofNotice, type Proof } from "../../release/prove.ts";
import { running, UNSTAMPED } from "../../kernel/version.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import { figure as fig } from "../figure.ts";
import { homeFlowJs } from "./home_flow_client.ts";
import { liveRegionsJs } from "../client.ts";
import { html, type Html } from "../html.ts";
import { fragment, page, redirect } from "../layout.ts";
import { BOOTED } from "../../release/gate.ts";
import { secureFor } from "../../http/cookie_secure.ts";
import { cookieValue } from "../../http/context.ts";
import { parseTable, tableParams, tableRows, type TableQuery } from "../../flow/lanes_table.ts";
import { TABLE_LIVE, tableRegion, tableTag, tableTools } from "./home_table.ts";
import { interruptedOutLine } from "../studio/interrupted_out.ts";
import { listReposWritableTo } from "../../core/repos.ts";
import { chart, figuresGrid, figuresSection } from "./home_figures.ts";
import { tellBox } from "../studio/living.ts";
import { requestsCard } from "../requests_card.ts";
import { everydayCard } from "./everyday.ts";
import { untoldAnswer, markTold } from "../../core/requests.ts";
import { YOURE_IN_MESSAGE } from "../../actions/users.ts";
import { spawnedForge } from "../../spawn/claim.ts";


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

/** Where a lane's whole list is: the table, filtered to the lane (and the app, when one is chosen). */
function laneHref(key: LaneKey, only: string | null): string {
  return `/?view=table&lane=${key}${query(only)}`;
}

/** One lane: a live region that answers for itself (`/live/lane`), so an event redraws this lane and no other. */
export function laneRegion(
  view: LaneView,
  health: Health,
  only: string | null,
  _admin: boolean,
  now: number,
): Html {
  const key = view.key;
  const shown = view.items.length;
  const total = view.total;
  const href = laneHref(key, only);
  const ready = key === "asked" ? " ready" : "";
  const more = (n: number): string => (n <= 0 ? "" : `${n} more${ready}`);
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
      <h2 class="lane-name"><a class="lane-name-link" href="${href}" title="${LANE_HOLDS[key]}">${LANE_NAME[key]}</a></h2>
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
    ${total <= 4
      ? null
      : html`<p class="lane-more">
          <a class="lane-more-link" href="${href}"
            ><span class="lane-more-lg">${more(total - 5)}</span
            ><span class="lane-more-md">${more(total - 4)}</span
            ><span class="lane-more-sm">${more(total - 4)}</span></a
          >
          <button type="button" class="lane-toggle" aria-expanded="false" data-all="${String(total)}">Show all ${String(total)}</button>
          ${total > shown ? html`<a class="lane-all" href="${href}">All ${String(total)} in the table</a>` : null}
        </p>`}
  </section>`;
}


/** What the lanes' reading needs of the forge. */
const pictureOptions = (app: App): PictureOptions => ({ dataDir: app.config.dataDir, ceilingUsd: forgeCeiling(app.config) });
const optionsOf = (ctx: Ctx, user: { readonly id: string } | undefined = ctx.auth.user): PictureOptions => ({ ...pictureOptions(ctx.app), ...(user === undefined ? {} : { viewer: user.id }) });

const healthOf = (view: LaneView, picture: LanePicture, now: number): Health => laneHealth(view, { now, builders: picture.builders, moved: picture.moved, idle: picture.idle });

// ---- the strip: today's figures, and the one line that needs the owner ----

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
  return { value: `about ${money(strip.weekSpendUsd)}`, note: "spent by the crew in seven days, at list price; the provider has not reported its week", attn: false };
}

/** One thing that needs this person: an alarm (red: something is not working) or a notice (it can wait, and is not on fire). */
interface Need {
  readonly says: string;
  readonly href: string;
  readonly tone: "alarm" | "notice";
}

/** What needs this person, most pressing first: alarms, then notices, then what waits on them. One line says the first two; the proof's own record is on /releases. */
function needsOf(picture: LanePicture, viewer: { readonly id: string; readonly isAdmin: boolean }, dataDir: string, now: number): Need[] {
  const proof = viewer.isAdmin ? proofNotice(dataDir, running().version, now) : undefined;
  const asks = picture.asks[viewer.id];
  const waiting = asks === undefined ? null : waitingWords(asks.count, asks.oldest, new Date(now));
  const alarms: Need[] = [
    ...(proof?.tone === "alarm" ? [{ says: proof.sentence, href: "/releases#proof", tone: "alarm" as const }] : []),
    ...(viewer.isAdmin ? (picture.strip?.needs ?? []).map((n) => ({ says: n.says, href: n.href, tone: "alarm" as const })) : []),
  ];
  return [
    ...alarms,
    ...(proof?.tone === "notice" ? [{ says: proof.sentence, href: "/releases#proof", tone: "notice" as const }] : []),
    ...(waiting === null ? [] : [{ says: waiting, href: "/review", tone: "notice" as const }]),
  ];
}

/** The one line: what needs this person, at most two things, never a list; or that nothing does. Red only when something is not working. */
function needLine(needs: readonly Need[]): Html {
  if (needs.length === 0) return html`<p class="hf-calm"><span class="dot" data-tone="success"></span>Nothing needs you right now.</p>`;
  const [first, second] = needs;
  const more = needs.length - 2;
  const tone = first!.tone;
  return html`<p class="hf-need" data-tone="${tone}" role="status"><span class="dot" data-tone="${tone === "alarm" ? "danger" : "attn"}"></span><a href="${first!.href}">${first!.says}</a>${second === undefined ? null : html`<span class="hf-need-sep" aria-hidden="true">·</span><a href="${second.href}">${second.says}</a>`}${more > 0 ? html` <a class="hf-need-more" href="/boards">and ${String(more)} more</a>` : null}</p>`;
}

/**
 * The strip: the one line that needs this person and, for an admin, five
 * figures, each with its unit and, where the data has one, a trend. Everyone
 * else gets the line alone: the figures are the forge's.
 */
export function stripRegion(picture: LanePicture, viewer: { readonly id: string; readonly isAdmin: boolean }, dataDir: string, now: number): Html {
  const strip = picture.strip;
  const version = running().version;
  const proof = proofWords(lastProof(dataDir), version);
  const needs = needLine(needsOf(picture, viewer, dataDir, now));
  if (!viewer.isAdmin) return html`<section class="hf-strip" id="hf-strip" aria-label="What needs you" data-live="${STRIP_LIVE}" data-live-src="/live/strip">${needs}</section>`;
  const b = picture.builders;
  // The reason is only said while a slot is free: a busy crew has none.
  const idle = b.slots > 0 && b.running < b.slots ? picture.idle : null;
  const week = strip === null ? null : weekFigure(strip);
  const lead = strip?.lead.medianHours ?? null;
  return html`<section class="hf-strip" id="hf-strip" aria-label="Today's figures" data-live="${STRIP_LIVE}" data-live-src="/live/strip">
    ${needs}
    <div class="hf-figs">
      ${fig("Shipped in 24 hours", strip === null ? "—" : count(strip.landed), strip?.landed === 1 ? "change landed on main" : "changes landed on main", "/board", strip === null ? null : chart([...strip.landedHours].reverse(), "Changes landed per hour over the last 24 hours"))}
      ${fig("Median open to landed", lead === null ? "—" : duration(lead * 3_600_000), lead === null ? "nothing landed in 24 hours" : `median of ${count(strip!.lead.landed)} ${strip!.lead.landed === 1 ? "change" : "changes"}, 24 hours`, "/boards")}
      ${fig("Crew running", b.slots === 0 ? count(b.running) : `${count(b.running)} of ${count(b.slots)}`, b.slots === 0 ? "no builder slots set" : idle === null ? "builders at work now" : `idle: ${idle.word}`, idle === null ? "/settings/crew" : idle.href)}
      ${fig("Week used", week === null ? "—" : week.value, week === null ? "the week is not read yet" : week.note, "/settings/crew", null, week?.attn === true ? "attn" : null)}
      ${fig("Live version", version === UNSTAMPED ? "—" : version, html`live <time class="hf-age-ago" datetime="${BOOTED}">${span(now - Date.parse(BOOTED))}</time> · ${proof.text}`, "/releases", null, proof.tone)}
    </div>
  </section>`;
}

// ---- before the first reading: the same regions, saying so ----

/** A lane before the picture exists: its name, "reading…", and the address that fills it. The page's script fetches that address at once. */
function readingLane(key: LaneKey, only: string | null): Html {
  const scope = only === null ? null : html` data-live-repo="${only}"`;
  return html`<section class="lane" id="lane-${key}" data-lane="${key}" data-tone="quiet" data-count="" data-reading aria-busy="true"
    data-live="${LANE_LIVE[key]}" data-live-src="/live/lane?s=${key}${query(only)}"${scope}>
    <header class="lane-head">
      <h2 class="lane-name"><a class="lane-name-link" href="${laneHref(key, only)}" title="${LANE_HOLDS[key]}">${LANE_NAME[key]}</a></h2>
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
  // The people who run the forge are counted first: the line that says what waits on them is ready for their first page.
  const owners = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE is_admin = 1 AND is_agent = 0 LIMIT 4").all().map((u) => u.id);
  warmLanes(app.db, pictureOptions(app), Date.now(), owners);
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
  return html`<form class="hf-filter" method="get" action="/" id="hf-filter">
    <label class="hf-filter-label" for="hf-app">Show</label>
    <select class="input" id="hf-app" aria-label="Show one app, or everything" data-apps="${repos.join(",")}">
      <option value="" ${only === null ? html`selected` : null}>Every app</option>
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
    <a href="/?view=lanes${keep}" ${view === "lanes" ? html`aria-current="page"` : null}>Lanes</a>
    <a href="/?view=table${keep}" ${view === "table" ? html`aria-current="page"` : null}>Table</a>
  </nav>`;
}

// GET / (signed in) — the home: the lanes, or the table of the same items. Called by the root route, and `/home` redirects here.
export async function homeFlowPage(ctx: Ctx, known?: { readonly spawned: Awaited<ReturnType<typeof spawnedForge>> }): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const { view, asked } = viewOf(ctx);
  const only = filterOf(ctx.url);
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "page", now));
  const rendering = performance.now();
  const viewing = picture === undefined ? undefined : timePhase(ctx.request, "viewing", () => viewFor(ctx.app.db, user, picture, view === "table" ? null : only));
  // A spawned forge's owner is a client: the forge-wide figures are not theirs to see, whole home or lean.
  const spawned = known !== undefined ? known.spawned : await timePhaseAsync(ctx.request, "spawned", () => spawnedForge(ctx.app));
  const wide = user.isAdmin && spawned === undefined;
  const strip = picture === undefined ? readingStrip() : stripRegion(picture, { id: user.id, isAdmin: wide }, ctx.app.config.dataDir, now);
  // What the old home also carried and is not a lane: the box that tells the crew (with Notes and Talk), the welcome after an account is allowed, a spawned forge's address, the everyday-account ask, and a stranger's request for an account.
  const allowed = untoldAnswer(ctx.app.db, user.id) === "allowed";
  if (allowed) markTold(ctx.app.db, user.id, new Date().toISOString());
  const before = html`${allowed ? html`<div class="toast" data-tone="success" role="status" id="youre-in"><strong>${YOURE_IN_MESSAGE}</strong> Your account is open: tell the crew what you want to build.</div>` : null}
    <div class="hf-tell">${tellBox(ctx, user)}</div>`;
  // A client who asked for the whole home (`?all=1`) has a way back to their apps.
  const after = html`${ctx.url.searchParams.has("all") ? html`<p class="small muted" id="lean-home"><a href="/">Just my apps</a></p>` : null}${requestsCard(ctx, "home")}${everydayCard(ctx, user)}
    ${spawned?.url === undefined ? null : html`<p class="small muted" id="forge-address">Your forge: <a href="${spawned.url}">${new URL(spawned.url).host}</a></p>`}`;
  // A run the host stopped is named, with its way to try again, while it is within the day: the one place the web offers that.
  const stopped = user.kind === "agent" ? null : timePhase(ctx.request, "stopped", () => interruptedOutLine(ctx, listReposWritableTo(ctx.app.db, user, { withoutArchived: true, limit: 200 })));
  const forges = wide ? await timePhaseAsync(ctx.request, "forges", () => forgesRegion(ctx.app, false)) : null;
  let main: Html;
  const q = parseTable(ctx.url.searchParams);
  if (picture === undefined || viewing === undefined) {
    main = view === "table" ? html`${tableTools(q)}${readingTable(q)}` : html`<div class="hf-lanes">${LANES.map((k) => readingLane(k, only))}</div>`;
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
    ${before}
    ${strip}
    ${stopped}
    ${after}
    ${main}
    ${wide ? figuresSection(picture, now) : null}
    ${forges}
    <p class="hf-foot small muted">
      <span>${view === "table" ? "Every item of every lane, one row each; sort, filter and search are in the address, so a link is a view." : "Each lane is a step a change takes; a tile moves on by itself when its work does."}</span>
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
  if (picture === undefined) return fragment(readingLane(key, only), { request: ctx.request });
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
  if (user === undefined) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx, user), "lane", now));
  const rendering = performance.now();
  const wide = user.isAdmin && (await spawnedForge(ctx.app)) === undefined;
  const res = fragment(picture === undefined ? readingStrip() : stripRegion(picture, { id: user.id, isAdmin: wide }, ctx.app.config.dataDir, now), { request: ctx.request });
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

// GET /live/figures — the figures' grid alone, for the region that shows it. An admin's: the numbers are the forge's.
export async function liveFiguresFragment(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined || !user.isAdmin) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const now = Date.now();
  const picture = await timePhaseAsync(ctx.request, "picture", () => lanePicture(ctx.app.db, optionsOf(ctx), "lane", now));
  const rendering = performance.now();
  const res = fragment(picture === undefined ? figuresSection(undefined, now) : figuresGrid(picture, now), { request: ctx.request });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// GET /home — the home is `/` now: its old address goes there, keeping the view and the filters.
export function homeRedirect(ctx: Ctx): Response {
  return redirect(`/${ctx.url.search}`);
}
