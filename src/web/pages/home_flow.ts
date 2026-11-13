/**
 * The new home: what the forge is doing right now, on one screen. The
 * pipeline is the page: six lanes (asked, building, checks, review, landing,
 * live), each a live region of compact tiles with its own count and health in
 * words, so one event redraws one lane and a tile moves between lanes as the
 * work does. Above them a thin strip of the few figures that matter today and,
 * only when something truly needs the owner, one line. Below, the hosted
 * forges in one line.
 *
 * Nothing here polls. Every region is a `data-live` region of the one stream
 * every page holds (`liveRegionsJs`); a region is read from the lane picture
 * (`flow/lanes.ts`), computed once after a write and shared by every lane,
 * viewer and tab. The page is a static picture with scripts off.
 */

import type { App } from "../../app.ts";
import { childStandings } from "../../spawn/heartbeat.ts";
import { childAwake } from "../../spawn/host.ts";
import { cachedAlarms } from "../studio/alarm_lines.ts";
import { cachedKpis } from "../studio/home_cache.ts";
import { sparkline } from "../studio/kpi_row.ts";
import { weekShare } from "../../crew/week_read.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";
import {
  hoursWords,
  readLeadTime,
  type LeadTime,
} from "../../flow/lead_time.ts";
import type { Kpis } from "../../flow/kpis.ts";
import {
  LANES,
  LANE_HOLDS,
  LANE_NAME,
  lanePicture,
  laneHealth,
  viewFor,
  type Health,
  type LaneKey,
  type LaneView,
  type Viewing,
} from "../../flow/lanes.ts";
import { span } from "../../flow/pipeline.ts";

/** The median as a person says it: minutes under an hour, else hours. */
const leadWords = (h: number): string => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : hoursWords(h));
import { lastProof, proofNeed, type Proof } from "../../release/prove.ts";
import { running } from "../../kernel/version.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import { homeFlowJs } from "./home_flow_client.ts";
import { liveRegionsJs } from "../client.ts";
import { html, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { BOOTED } from "../../release/gate.ts";
import { nowHref } from "./now.ts";
import { sha } from "../ui.ts";

/** The events that can move work between lanes, per lane. A burst of them is one fetch of the lane. */
const LANE_LIVE: Record<LaneKey, string> = {
  asked:
    "issue.opened,issue.closed,issue.reopened,issue.blocked,issue.unblocked,run.queued,run.started,run.finished",
  building: "run.queued,run.started,run.finished,pull.opened,pull.closed",
  checks:
    "run.queued,run.started,run.finished,pull.opened,pull.pushed,pull.merged",
  review:
    "run.queued,run.started,run.finished,pull.reviewed,pull.closed,pull.merged",
  landing:
    "pull.reviewed,pull.merged,pull.closed,pull.pushed,queue.*,run.finished,app.serving",
  live: "app.serving,release.*,run.finished,run.started,pull.merged",
};
const STRIP_LIVE =
  "pull.merged,run.finished,release.*,app.serving,app.stopped,forge.*,queue.*";
const FORGES_LIVE = "forge.*";

/** An `owner/name` the filter may hold; anything else is no filter. */
const APP_SLUG = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

const filterOf = (url: URL): string | null => {
  const v = url.searchParams.get("app") ?? "";
  return APP_SLUG.test(v) ? v : null;
};

const query = (only: string | null): string =>
  only === null ? "" : `&app=${encodeURIComponent(only)}`;

/** A stretch of time as a clock the page keeps: the words the server uses, redrawn by the page's script on any event. */
function age(iso: string, now: number): Html {
  const at = Date.parse(iso);
  return html`<time class="hf-age" datetime="${new Date(at).toISOString()}"
    >${span(now - at)}</time
  >`;
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
  const more =
    i.more > 0
      ? html`<span class="tile-more"
          >and ${String(i.more)} more
          ${i.more === 1 ? "change" : "changes"}</span
        >`
      : null;
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
      ${more}
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
            ><span class="lane-more-lg">${rest === 0 ? "" : `${rest} more`}</span
            ><span class="lane-more-md">${md === 0 ? "" : `${md} more`}</span
            ><span class="lane-more-sm">${sm === 0 ? "" : `${sm} more`}</span></a
          >
        </p>`}
  </section>`;
}

/** The numbers every lane's words need that are not in the lane. */
function healthInput(kpis: Kpis | undefined, now: number) {
  return {
    now,
    builders:
      kpis === undefined
        ? { running: 0, slots: 0 }
        : { running: kpis.builders.running, slots: kpis.builders.slots },
  };
}

// ---- the strip: today's figures, and the one line that needs the owner ----

/** What the strip reads, kept 15 s for the whole forge: it is built once and every tab and every event reads it. */
interface StripData {
  readonly at: number;
  readonly kpis: Kpis;
  readonly lead: LeadTime;
  readonly week: {
    readonly usedPct: number;
    readonly mayUsePct: number;
  } | null;
  readonly proof: Proof | undefined;
  readonly needs: readonly { readonly says: string; readonly href: string }[];
}

const STRIP_REUSE_MS = process.env["NODE_ENV"] === "test" ? 0 : 15_000;
const strips = new WeakMap<App, StripData>();

/** Alarms worth the owner's eyes now: a stopped forge or landing line, a red main, a stuck run, no release, a lost backup. */
const REAL = new Set([
  "red_main",
  "landing_stopped",
  "lane_stopped",
  "stuck",
  "unreachable",
  "backup",
  "no_release",
]);

function stripData(app: App, now = Date.now()): StripData {
  const kept = strips.get(app);
  if (kept !== undefined && now - kept.at < STRIP_REUSE_MS) return kept;
  const date = new Date(now);
  const ceilingUsd = forgeCeiling(app.config);
  const kpis = cachedKpis(app.db, date, {
    ceilingUsd,
    dataDir: app.config.dataDir,
  });
  const proof = lastProof(app.config.dataDir);
  const unproven = proofNeed(app.config.dataDir, running().version);
  const needs = [
    ...(unproven === undefined
      ? []
      : [{ says: unproven.sentence, href: "/releases" }]),
    ...cachedAlarms(app.db, date, ceilingUsd, app.config.dataDir)
      .filter((a) => REAL.has(a.key))
      .map((a) => ({ says: a.says, href: a.href })),
  ];
  const data: StripData = {
    at: now,
    kpis,
    lead: readLeadTime(app.db, date),
    week: weekShare(app, date),
    proof,
    needs,
  };
  strips.set(app, data);
  return data;
}

function fig(
  label: string,
  value: Html | string,
  note: Html | string,
  href: string,
  extra: Html | null = null,
  tone: "attn" | null = null,
): Html {
  return html`<a
    class="hf-fig"
    href="${href}"
    ${tone === null ? null : html`data-tone="${tone}"`}
  >
    <span class="hf-fig-label">${label}</span>
    <span class="hf-fig-value num">${value}</span>
    <span class="hf-fig-note">${note}</span>
    ${extra === null ? null : html`<span class="hf-fig-spark">${extra}</span>`}
  </a>`;
}

function proofWords(
  proof: Proof | undefined,
  version: string,
): { text: string; tone: "attn" | null } {
  if (proof === undefined) return { text: "not proven yet", tone: null };
  if (proof.version !== version) return { text: "proof running", tone: null };
  return proof.ok
    ? { text: "journey proof passed", tone: null }
    : { text: "journey proof failed", tone: "attn" };
}

/** The strip: five figures, each with its unit and, where the data has one, a trend; and the one line that needs the owner. */
export function stripRegion(app: App, now = Date.now()): Html {
  const d = stripData(app, now);
  const k = d.kpis;
  const live = running().commit;
  const proof = proofWords(d.proof, running().version);
  const need = d.needs[0];
  const others = d.needs.length - 1;
  const week = d.week;
  return html`<section
    class="hf-strip"
    id="hf-strip"
    aria-label="Today's figures"
    data-live="${STRIP_LIVE}"
    data-live-src="/live/strip"
  >
    ${need === undefined
      ? html`<p class="hf-calm">
          <span class="dot" data-tone="success"></span>Nothing needs you right now.
        </p>`
      : html`<p class="hf-need" role="status">
          <span class="dot" data-tone="danger"></span
          ><a href="${need.href}">${need.says}</a>${others > 0
            ? html` <a class="hf-need-more" href="/boards"
                >and ${String(others)} more</a
              >`
            : null}
        </p>`}
    <div class="hf-figs">
      ${fig(
        "Shipped in 24 hours",
        String(k.landed),
        k.landed === 1 ? "change landed on main" : "changes landed on main",
        "/board",
        sparkline(k.landedHours),
      )}
      ${fig(
        "Median open to landed",
        d.lead.medianHours === null ? "—" : leadWords(d.lead.medianHours),
        d.lead.medianHours === null
          ? "nothing landed in 24 h"
          : `median of ${d.lead.landed} ${d.lead.landed === 1 ? "change" : "changes"}, 24 h`,
        "/boards",
      )}
      ${fig(
        "Crew running",
        k.builders.slots === 0
          ? String(k.builders.running)
          : `${k.builders.running} of ${k.builders.slots}`,
        k.builders.slots === 0
          ? "no builder slots set"
          : "builders at work now",
        "/settings/crew",
      )}
      ${fig(
        "Week used",
        week === null ? "—" : `${week.usedPct}%`,
        week === null
          ? "the week is not measured yet"
          : `of the crew's week; it may use ${week.mayUsePct}%`,
        "/settings/crew",
        null,
        week !== null && week.usedPct >= week.mayUsePct ? "attn" : null,
      )}
      ${fig(
        "Live version",
        live === null ? "—" : sha(live),
        live === null
          ? "nothing live yet"
          : html`live
              <time class="hf-age-ago" datetime="${BOOTED}"
                >${span(now - Date.parse(BOOTED))}</time
              >
              · ${proof.text}`,
        "/releases",
        null,
        proof.tone,
      )}
    </div>
  </section>`;
}

// ---- hosted forges, in one line ----

interface Forges {
  readonly at: number;
  readonly total: number;
  readonly awake: number;
  readonly quiet: readonly string[];
}
const forgesKept = new WeakMap<App, Forges>();

async function forgesOf(app: App, now = Date.now()): Promise<Forges> {
  const kept = forgesKept.get(app);
  if (kept !== undefined && now - kept.at < (STRIP_REUSE_MS === 0 ? 0 : 20_000))
    return kept;
  const { items, more } = await childStandings(app, now);
  const awakeNow = items.filter((c) => childAwake(app, c.name));
  // An awake forge that has stopped reporting to this one is the one worth a name.
  const quiet = awakeNow.filter((c) => c.state === "quiet").map((c) => c.name);
  const out: Forges = {
    at: now,
    total: items.length + more,
    awake: awakeNow.length,
    quiet,
  };
  forgesKept.set(app, out);
  return out;
}

export async function forgesRegion(app: App): Promise<Html> {
  const f = await forgesOf(app);
  const words =
    f.total === 0
      ? "No hosted forges yet."
      : `${f.total} hosted ${f.total === 1 ? "forge" : "forges"}: ${f.awake} awake, ${f.total - f.awake} asleep (a sleeping forge wakes when someone opens it). ${f.quiet.length === 0 ? "None is stuck." : `${f.quiet.join(", ")} ${f.quiet.length === 1 ? "is" : "are"} awake but not reporting.`}`;
  return html`<p
    class="hf-forges"
    id="hf-forges"
    data-live="${FORGES_LIVE}"
    data-live-src="/live/forges"
    data-tone="${f.quiet.length === 0 ? "ok" : "attn"}"
  >
    <span
      class="dot"
      ${f.quiet.length === 0 ? null : html`data-tone="attn"`}
    ></span
    ><a href="/forges">${words}</a>
  </p>`;
}

// ---- the page ----

function filterForm(repos: readonly string[], only: string | null): Html {
  const opts =
    only !== null && !repos.includes(only) ? [...repos, only].sort() : repos;
  return html`<form
    class="hf-filter"
    method="get"
    action="/home"
    id="hf-filter"
  >
    <label class="hf-filter-label" for="hf-app">Show</label>
    <select
      class="input"
      id="hf-app"
      name="app"
      aria-label="Show one app, or everything"
    >
      <option value="" ${only === null ? html`selected` : null}>
        Every app (${String(repos.length)})
      </option>
      ${opts.map(
        (r) =>
          html`<option value="${r}" ${r === only ? html`selected` : null}>
            ${r}
          </option>`,
      )}
    </select>
    <noscript><button class="btn" type="submit">Show</button></noscript>
  </form>`;
}

/** The six lane regions as one viewer reads them. */
function lanes(
  ctx: Ctx,
  only: string | null,
  now: number,
): { lanes: Html[]; viewing: Viewing } {
  const user = ctx.auth.user!;
  const picture = timePhase(ctx.request, "picture", () =>
    lanePicture(ctx.app.db, now),
  );
  const viewing = timePhase(ctx.request, "viewing", () =>
    viewFor(ctx.app.db, user, picture, only),
  );
  const kpis = user.isAdmin ? stripData(ctx.app, now).kpis : undefined;
  const input = healthInput(kpis, now);
  return {
    viewing,
    lanes: LANES.map((k) =>
      laneRegion(
        viewing.lanes[k],
        laneHealth(
          viewing.lanes[k],
          viewing.stages.find((s) => stageOf(k) === s.key),
          input,
        ),
        only,
        user.isAdmin,
        now,
      ),
    ),
  };
}

/** The pipeline stage whose own count a lane reports: only the asked lane reads its stage, the rest count what they hold. */
const stageOf = (k: LaneKey): string => (k === "asked" ? "ready" : "");

// GET /home — the new home.
export async function homeFlowPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const rendering = performance.now();
  const only = filterOf(ctx.url);
  const now = Date.now();
  const { lanes: regions, viewing } = lanes(ctx, only, now);
  const strip = user.isAdmin
    ? timePhase(ctx.request, "strip", () => stripRegion(ctx.app, now))
    : null;
  const forges = user.isAdmin
    ? await timePhaseAsync(ctx.request, "forges", () => forgesRegion(ctx.app))
    : null;
  const body = html`<div class="hf" id="hf">
    <header class="hf-head">
      <div class="hf-title">
        <h1>Your forge, right now</h1>
        <p class="hf-live muted" id="hf-live" data-state="connecting">
          <span class="dot"></span
          ><span class="hf-live-text">Updates as it happens</span>
        </p>
      </div>
      ${filterForm(viewing.repos, only)}
    </header>
    ${strip}
    <div class="hf-lanes">${regions}</div>
    ${forges}
    <p class="hf-foot small muted">
      <span>Each lane is a step a change takes; a tile moves on by itself when its work does.</span>
      <a href="/?home=classic">The classic home</a>
      <a href="/feed">The feed</a>
    </p>
  </div>`;
  const res = page({
    ctx,
    title: "Home",
    body,
    wide: true,
    scriptJs: `${liveRegionsJs}\n${homeFlowJs}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// GET /live/lane?s=<lane>[&app=owner/name] — one lane alone, for the region that shows it.
export function liveLaneFragment(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  const key = LANES.find((k) => k === ctx.url.searchParams.get("s"));
  if (user === undefined || key === undefined) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const rendering = performance.now();
  const only = filterOf(ctx.url);
  const now = Date.now();
  const picture = timePhase(ctx.request, "picture", () =>
    lanePicture(ctx.app.db, now),
  );
  const viewing = timePhase(ctx.request, "viewing", () =>
    viewFor(ctx.app.db, user, picture, only),
  );
  const view = viewing.lanes[key];
  const kpis = user.isAdmin ? stripData(ctx.app, now).kpis : undefined;
  const health = laneHealth(
    view,
    viewing.stages.find((s) => stageOf(key) === s.key),
    healthInput(kpis, now),
  );
  const res = fragment(laneRegion(view, health, only, user.isAdmin, now), {
    request: ctx.request,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// GET /live/strip — the figures and the one line, alone.
export function liveStripFragment(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined || !user.isAdmin) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const rendering = performance.now();
  const res = fragment(
    timePhase(ctx.request, "strip", () => stripRegion(ctx.app)),
    { request: ctx.request },
  );
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
  const res = fragment(
    await timePhaseAsync(ctx.request, "forges", () => forgesRegion(ctx.app)),
    { request: ctx.request },
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}
