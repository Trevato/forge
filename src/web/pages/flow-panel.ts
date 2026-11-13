/**
 * The flow panel, drawn for /boards: the pipeline with what each
 * stage let out, the bottleneck sentence, conflicted and requested pulls,
 * throughput, why ready issues wait, and the merge
 * queue (the numbers come from `src/flow`). `/boards` shows it
 * to the owner; the old `/flow` redirects here. Every
 * count links back to the page that drew it with `?out=<what>[&hour=<0–23>]`.
 */

import { MERGE_QUEUE_HELP } from "../../flow/help.ts";
import { helpAsked, pageHelp } from "../page_help.ts";
import { HELD_EXPLAINED } from "./boards-held.ts";
import type { Reader } from "../../actions/telemetry.ts";
import { queuesFor } from "../../system/telemetry.ts";
import { conflictedSays, rebaseLaneSays } from "../../flow/conflicted.ts";
import { pileSays } from "../../flow/pile.ts";
import { reviewingSays } from "../../flow/reviewing.ts";
import { requestedSays } from "../../flow/requested.ts";
import {
  bottleneck,
  readPipeline,
  span,
  STAGE_HOLDS,
  STAGE_LABEL,
  verdict,
  waited,
  type PipelineKey,
} from "../../flow/pipeline.ts";
import {
  HOURS,
  itemsIn,
  OUTFLOW,
  readThroughput,
  stageOf,
} from "../../flow/throughput.ts";
import { type QueueRow, redBatchWords } from "../../flow/queue.ts";
import { HOT_PULLS, pullCounts, warmFiles } from "../../crew/hot_files.ts";
import { warmingLine } from "../../crew/hot_history.ts";
import { getRepoById } from "../../core/repos.ts";
import { IDLE_LIMIT, type IdlePull } from "../../flow/idle_pulls.ts";
import { panelFigures } from "../../flow/panel_cache.ts";
import { buildYieldSays } from "../../flow/build_yield.ts";
import { DECLINE_LABELS, DECLINE_REASONS } from "../../flow/declines.ts";
import { reviewLatencySays } from "../../flow/review_latency.ts";
import { openerCounts } from "../../flow/openers.ts";
import { readRepeats, type Repeats } from "../../flow/repeats.ts";
import { readHeld } from "../../flow/held.ts";
import { readVerified, verifiedSays, type VerifiedRow } from "../../flow/verified.ts";
import type { App } from "../../app.ts";
import { html, type Html } from "../html.ts";
import { doctorCard } from "./boards-doctor.ts";
import { keeperRow } from "../studio/keeper_row.ts";
import { beatFact, lastBeat } from "../../keeper/beat.ts";
import { gatesSection } from "./boards-gates.ts";
import { heldCard } from "./boards-held.ts";
import { badge, card, meter } from "../ui.ts";
import { count, figure, figures, fold } from "../figure.ts";
import { panelFlow, type BoardsPicture, type StageFlow } from "../../flow/pages_read.ts";
import { sparkline as homeSpark } from "../studio/kpi_row.ts";

/** What the panel draws that is read off the thread: the figures, what each stage let out, what reviewers repeated and why ready issues wait. */
export type PanelPicture = Pick<BoardsPicture, "fig" | "flow" | "repeats" | "held">;

/** The events that move work between stages. The region has no address of its own, so the page's script refetches the page for it at most once in 30 s (`liveRegionsJs`). */
const FLOW_LIVE = "run.queued,run.started,run.finished,pull.opened,pull.reviewed,pull.merged,pull.closed,queue.*,app.serving";

/** The stage `?out=` asks to list, or null: the one stage whose items a page's picture must carry. */
export const outAsked = (url: URL): PipelineKey | null => asked(url)?.key ?? null;

/** What `?out=` and `?hour=` ask to list, checked: an unknown stage or hour lists nothing. */
function asked(url: URL): { key: PipelineKey; hour: number | null } | null {
  const key = stageOf(url.searchParams.get("out") ?? "");
  if (key === undefined) return null;
  const h = url.searchParams.get("hour");
  if (h === null) return { key, hour: null };
  if (!/^\d{1,2}$/.test(h) || Number(h) >= HOURS) return null;
  return { key, hour: Number(h) };
}

const outHref = (base: string, key: PipelineKey, hour: number | null): string =>
  `${base}?out=${OUTFLOW[key].out}${hour === null ? "" : `&hour=${hour}`}#out`;

const hourWords = (hour: number | null): string =>
  hour === null ? "in the last 24 hours" : hour === 0 ? "in the last hour" : `${hour}–${hour + 1} hours ago`;

/**
 * 24 bars, oldest on the left: a picture only, hidden from assistive tech and
 * out of the tab order. The two counts beside it are the way in (#1786).
 */
function sparkline(t: StageFlow): Html {
  const max = Math.max(1, ...t.hours);
  const bars = t.hours.map((n, hour) => {
    const x = (HOURS - 1 - hour) * 3;
    const h = n === 0 ? 1 : Math.max(2, Math.round((n / max) * 16));
    return html`<rect ${n === 0 ? html`fill-opacity="0.3"` : null} x="${String(x)}" y="${String(16 - h)}" width="2" height="${String(h)}" />`;
  });
  return html`<svg class="pl-spark" viewBox="0 0 72 16" width="72" height="16" fill="currentColor" aria-hidden="true" focusable="false">${bars}</svg>`;
}

/** What a stage let out: the last hour, the day, and the day's 24 hours as bars. Both counts list what they counted. */
function outCells(base: string, t: StageFlow): Html {
  const { day, passed } = t;
  const what = `${OUTFLOW[t.key].label}${t.key === "checking" && day > 0 ? `: ${passed} passed, ${day - passed} failed` : ""}`;
  return html`<td class="num" data-label="Out, 1 h" data-out="${OUTFLOW[t.key].out}">
      <a href="${outHref(base, t.key, 0)}" data-hour="0" title="${what}, in the last hour">${count(t.hours[0] ?? 0)}</a>
    </td>
    <td class="num" data-label="Out, 24 h">
      <a href="${outHref(base, t.key, null)}" data-day="${String(day)}" title="${what}, in the last 24 hours">${count(day)}</a>
    </td>
    <td class="pl-trend" title="${what}, each hour of the last 24">${sparkline(t)}</td>`;
}

/** The panel for `reader`; `base` is the page it sits on, where its counts link. `between` is drawn under the pipeline, above the detail. */
export function flowPanel(app: App, reader: Reader, url: URL, base: string, slots: { picture?: PanelPicture; now?: Html | null; between?: Html | null; first?: Html | null; last?: Html | null } = {}): Html {
  const now = Date.now();
  const stages = readPipeline(app.db, new Date(now));
  const worst = bottleneck(stages);
  const owner = reader.kind === "owner";
  // A page hands in the picture a worker read (`flow/pages.ts`); only a direct caller (a test) reads it here.
  const pic: PanelPicture = slots.picture ?? {
    fig: panelFigures(app.db, reader.kind, new Date(now)),
    flow: panelFlow(readThroughput(app.db, stages.map((s) => s.key), new Date(now)), asked(url)?.key ?? null),
    repeats: readRepeats(app.db, "", new Date(now), !owner),
    held: readHeld(app, owner, now),
  };
  const { flow, fig } = pic;
  const out = new Map(flow.stages.map((t) => [t.key, t]));
  const landed = out.get("approved");
  const checked = out.get("checking")?.day ?? 0;
  const passed = out.get("checking")?.passed ?? 0;
  const ready = stages.find((s) => s.key === "ready");
  const conflicted = conflictedSays(fig.conflicted, now);
  const lane = rebaseLaneSays(fig.lane);
  const onBuilder = requestedSays(fig.requested.builder, "builder", now);
  const onReviewer = requestedSays(fig.requested.reviewer, "reviewer", now);
  const reviewing = reviewingSays(fig.reviewing);
  const { lead, yielded, latency, openers, idle, parked } = fig;
  const pile = pileSays(fig.pile);
  const newest = parked.newest[0];
  const listed = asked(url);
  const shown = listed === null ? undefined : out.get(listed.key);
  const help = pageHelp([
    ["Stages", html`${(Object.keys(STAGE_HOLDS) as PipelineKey[]).map((k, i) => html`${i === 0 ? "" : "; "}<strong>${STAGE_LABEL[k]}</strong>: ${STAGE_HOLDS[k]}`)}.`],
    ["Ready, and why it waits", HELD_EXPLAINED],
    ["Merge queue", MERGE_QUEUE_HELP],
    ["Verified after landing", html`A repository that declares <span class="mono">check.verify</span> in forge.json has its main verified after landing.`],
    ["Elsewhere", html`Limits are set on <a href="/settings/capacity">Capacity</a>. How the forge stands against its threats is on <a href="/resilience">Resilience</a>; where an outside agent can help is on <a href="/contribute">Contribute</a>.`],
  ], helpAsked(url));
  const landedDay = landed?.day ?? 0;
  const strip = figures([
    figure("Landed, last hour", html`<span data-landed-hour>${count(landed?.hours[0] ?? 0)}</span>`, html`<span data-landed-day>${count(landedDay)}</span> ${landedDay === 1 ? "change" : "changes"} landed on main in 24 hours`, outHref(base, "approved", null), landed === undefined ? null : homeSpark(landed.hours)),
    figure("Asked to live", html`<span data-median>${flow.medianAskToLiveMs === null ? "—" : span(flow.medianAskToLiveMs)}</span>`, flow.medianAskToLiveMs === null ? "nothing asked for went live in 24 hours" : "median from an ask to it serving, last 24 hours", outHref(base, "live", null)),
    figure("Opened to landed", lead.medianHours === null ? "—" : html`<span data-median-hours>${span(lead.medianHours * 3_600_000)}</span>`, lead.medianHours === null ? "nothing landed in 24 hours" : html`median for a pull; the slowest took <span data-max-hours>${span((lead.maxHours ?? 0) * 3_600_000)}</span>`, outHref(base, "approved", null)),
    figure("Waiting to start", count(ready?.waiting ?? 0), ready === undefined || ready.waiting === 0 ? "no ready issue waits for a builder" : `ready ${ready.waiting === 1 ? "issue" : "issues"}; the oldest has waited ${waited(ready, now) ?? "no time"}`, "#held", null, worst?.key === "ready" ? "attn" : null),
    figure("Checks passing", checked === 0 ? "—" : `${Math.round((passed / checked) * 100)}%`, checked === 0 ? "no check finished in 24 hours" : `${count(passed)} of ${count(checked)} checks passed in 24 hours`, outHref(base, "checking", null), null, checked > 0 && passed / checked < 0.5 ? "attn" : null),
  ], "The last 24 hours");
  return html`<div class="bd-live" id="flow-live" data-live="${FLOW_LIVE}">
    <section class="bd-now" id="flow-summary" aria-label="How the pipeline stands">
      <p class="bd-lead" id="bottleneck" data-stage="${worst?.key ?? ""}"><strong>${verdict(stages, now)}</strong></p>
      ${slots.now ?? null}
      ${keeperRow(app.db, owner)}
      <p id="pile">${pile}</p>
      ${lane === null ? "" : html`<p id="rebase-lane">Rebases: ${lane}.</p>`}
      ${conflicted === null ? "" : html`<p id="conflicted">${conflicted}</p>`}
      ${onBuilder === null ? "" : html`<p id="requested-builder">${onBuilder}</p>`}
      ${onReviewer === null ? "" : html`<p id="requested-reviewer">${onReviewer}</p>`}
      ${reviewing === null ? "" : html`<p id="review-load">${reviewing}</p>`}
      ${idle.length === 0
        ? ""
        : html`<div id="idle-pulls" data-count="${String(idle.length)}">
            <p>${idleCount(idle)} idle pull${idle.length === 1 ? "" : "s"}:</p>
            <ul class="list">${idle.slice(0, 3).map(idleRow)}
              ${idle.length > 3
                ? html`<li><a class="row flow-row small" href="${base}?idle=all#idle-list" data-more><span class="row-main">and ${String(idle.length - 3)}${idle.length >= IDLE_LIMIT ? "+" : ""} more</span></a></li>`
                : null}
            </ul>
          </div>`}
      ${parked.week === 0 || newest === undefined
        ? ""
        : html`<p id="parked" data-day="${String(parked.day)}" data-week="${String(parked.week)}">
            ${String(parked.day)} parked today, ${String(parked.week)} this week; newest
            <a href="/${newest.repo}/issues/${String(newest.issue)}">${newest.repo} #${String(newest.issue)}</a>
          </p>`}
    </section>
    ${strip}
    <section class="bd-block" id="pipeline" aria-labelledby="pipeline-h">
      <header class="bd-head"><h2 id="pipeline-h">Pipeline</h2><p class="bd-sub">Each row is a step a change takes: what waits there, what is being worked on, and what the step let out.</p><a href="/pipeline">The four steps</a><a href="/settings/capacity">Capacity</a></header>
      <div class="card">
        <table class="table pl" aria-label="Pipeline stages">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Capacity</th>
              <th scope="col" class="num">Waiting</th>
              <th scope="col" class="num">Active</th>
              <th scope="col" class="num">Oldest wait</th>
              <th scope="col" class="num">Out, last hour</th>
              <th scope="col" class="num">24 hours</th>
              <th scope="col"><span class="sr-only">Each hour</span></th>
            </tr>
          </thead>
          <tbody>
            ${stages.map(
              (s) =>
                html`<tr
                  data-stage="${s.key}"
                  ${s === worst ? html`data-bottleneck="true"` : null}
                >
                  <th scope="row">
                    ${STAGE_LABEL[s.key]}
                    ${s === worst ? badge("bottleneck", { tone: "danger" }) : null}
                  </th>
                  <td class="pl-cap" data-label="Capacity" ${s.capacity === null ? html`data-zero` : null}>${s.capacity ?? "—"}</td>
                  <td class="num" data-label="Waiting" ${s.waiting === 0 ? html`data-zero` : null}>${count(s.waiting)}</td>
                  <td class="num" data-label="Active" ${s.key === "live" || s.active === 0 ? html`data-zero` : null}>${s.key === "live" ? "—" : count(s.active)}</td>
                  <td class="num" data-label="Oldest" ${s.oldestWaiting === null ? html`data-zero` : null}>${waited(s, now) ?? "—"}</td>
                  ${outCells(base, out.get(s.key)!)}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>
    </div>
    ${slots.between ?? null}
    <section class="bd-block" id="detail" aria-labelledby="detail-h">
      <header class="bd-head"><h2 id="detail-h">Go deeper</h2><p class="bd-sub">Each line says how it stands now; open one for what is behind it.</p></header>
      <div class="folds">
      ${slots.first ?? null}
      ${fold("The last 24 hours", `${count(yielded.finished)} ${yielded.finished === 1 ? "build" : "builds"} finished, ${openers.length === 0 ? "no pull" : `${count(openers.reduce((n, o) => n + o.opened, 0))} pulls`} opened in the last hour`, html`
        <p id="build-yield">${buildYieldSays(yielded)}</p>
        ${fig.declined.says === ""
          ? ""
          : html`<p id="declines">Declined in 24 h: ${DECLINE_REASONS.filter((r) => fig.declined.groups[r].count > 0).map(
              (r, i) => html`${i === 0 ? "" : ", "}<span data-reason="${r}">${String(fig.declined.groups[r].count)} ${DECLINE_LABELS[r]}</span> (${fig.declined.runs[r].map(
                (x, j) => html`${j === 0 ? "" : ", "}<a href="/${x.repo}/runs/${x.runId}">#${String(x.issue)}</a>`,
              )}${fig.declined.groups[r].distinct > fig.declined.runs[r].length ? ", …" : ""})`,
            )}</p>`}
        <p id="review-latency">${reviewLatencySays(latency)}</p>
        <p id="openers">
          Opened in the last hour:
          ${openers.length === 0
            ? "no pulls"
            : openers.map((o, i) => html`${i === 0 ? "" : " · "}<a href="/${o.author}">${o.author}</a> ${openerCounts(o)}`)}
        </p>
        <p id="system-link">Which test files are running in more than one check right now, and what each check is using, is on <a href="/system">System</a>.</p>
        ${owner ? html`<p id="keeper-heartbeat-row">Release tick: <span id="keeper-heartbeat">${beatFact(lastBeat(app.db), new Date(now))}</span></p>` : ""}`, { id: "day" })}
      ${heldCard(pic.held)}
      ${queueCard(queuesFor(app, reader, new Date(now), { batches: true }))}
      ${gatesSection(app.db, owner, now)}
      ${doctorCard(app.db, owner, now)}
      ${hotFilesCard(app, reader)}
      ${verifiedCard(readVerified(app, owner), now)}
      ${repeatsCard(pic.repeats)}
      ${slots.last ?? null}
      </div>
      ${help}
    </section>
    ${url.searchParams.get("idle") === "all" && idle.length > 0 ? idleList(idle) : null}
    ${listed === null || shown === undefined ? null : outList(shown, listed.hour, now)}`;
}

/** What reviewers repeated (#8716): the proposals and retirements, beside comments per pull. */
function repeatsCard(r: Repeats): Html {
  return fold(
    "Review repeats",
    r.findings.length === 0 ? "no finding repeated" : `${count(r.findings.length)} repeated ${r.findings.length === 1 ? "finding" : "findings"}`,
    html`<p data-repeats data-scope="${r.scope}">${r.says}.</p>
      ${r.findings.length === 0
        ? null
        : html`<ul>${r.findings.map((f) => html`<li data-finding>${f.sample} <span class="muted small">seen ${String(f.seen)}× · #${String(f.issue)}${f.retired ? " · retired" : ""}</span></li>`)}</ul>`}`,
    { id: "repeats" },
  );
}

/**
 * How long main has gone unverified, per repository whose main is verified
 * after landing (#7786): the whole suite runs there on a schedule, after
 * landings that were judged on lint and types.
 */
function verifiedCard(rows: readonly VerifiedRow[], now: number): Html {
  return fold(
    "Verified after landing",
    rows.length === 0 ? "no repository asks for it" : `${count(rows.length)} ${rows.length === 1 ? "repository" : "repositories"}`,
    html`${rows.length === 0
        ? html`<p class="muted">None declare <span class="mono">check.verify</span></p>`
        : rows.map(
            (r) =>
              html`<p data-verified="${r.repo}" data-unverified-since="${r.unverifiedSince ?? ""}">
                <a href="/${r.repo}">${r.repo}</a>: ${verifiedSays(r, now)}
                ${r.last === null ? null : html`· <a class="small" href="/${r.repo}/runs/${r.last.runId}">run</a>`}
              </p>`,
          )}`,
    { id: "verified" },
  );
}

/** The count, `20+` when the read stopped at its limit. */
const idleCount = (idle: readonly IdlePull[]): string => `${idle.length}${idle.length >= IDLE_LIMIT ? "+" : ""}`;

/** One idle pull as a touch-sized row linking to the pull. */
function idleRow(p: IdlePull): Html {
  return html`<li><a class="row flow-row" href="/${p.owner}/${p.repo}/pulls/${String(p.pull)}"><span class="row-main"><span class="row-title">${p.repo} #${String(p.pull)}</span><span class="row-meta">idle ${String(Math.floor(p.hours))} h</span></span></a></li>`;
}

/** Every idle pull, oldest first: where "and K more" lands. */
function idleList(idle: readonly IdlePull[]): Html {
  return card(html`<h2>${idleCount(idle)} idle pull${idle.length === 1 ? "" : "s"}</h2><ul class="list">${idle.map(idleRow)}</ul>`, {
    id: "idle-list",
    pad: false,
  });
}

/** The merge queue, one row per repository with something in it or landed. */
function queueCard(rows: readonly QueueRow[]): Html {
  const queued = rows.reduce((n, r) => n + r.queued + r.gating, 0);
  const landedHour = rows.reduce((n, r) => n + r.landedHour, 0);
  return fold(
    "Merge queue",
    `${queued === 0 ? "nothing queued" : `${count(queued)} queued`}; ${count(landedHour)} landed in the last hour`,
    html`${rows.length === 0
        ? html`<p class="muted">Nothing queued, gating or landed in the last hour.</p>`
        : html`<div class="table-scroll">
            <table class="table" data-dense aria-label="Merge queue">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col" class="num">Queued</th>
                  <th scope="col" class="num">Gating</th>
                  <th scope="col" class="num">Gates</th>
                  <th scope="col" class="num">Landed, last hour</th>
                  <th scope="col" class="num">Approved to landed</th>
                  <th scope="col" class="num">Red batches, last hour</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) =>
                    html`<tr data-queue="${r.repo}">
                      <th scope="row"><a href="/${r.repo}/pulls">${r.repo}</a></th>
                      <td class="num" data-queued>${String(r.queued)}</td>
                      <td class="num" data-gating>${String(r.gating)}</td>
                      <td class="num" data-gates>${String(r.gates)}</td>
                      <td class="num" data-landed>${String(r.landedHour)}</td>
                      <td class="num" data-approved-to-landed>${r.approvedToLanded === null ? "—" : `${r.approvedToLanded} min`}</td>
                      <td class="num" data-red-batches>${redBatchWords(r)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`}`,
    { id: "queue" },
  );
}

/** The items one count counted, newest first, each linked to where it lives. */
function outList(t: StageFlow, hour: number | null, now: number): Html {
  const items = itemsIn(t, hour, now);
  return card(
    html`<h2>${STAGE_LABEL[t.key]}: ${String(items.length)} ${OUTFLOW[t.key].label} ${hourWords(hour)}</h2>
      ${items.length === 0
        ? html`<p class="muted">None.</p>`
        : html`<ul>
            ${items.map(
              (i) =>
                html`<li>
                  <a href="${i.href}">${i.label}</a>
                  ${i.outcome === null ? null : badge(i.outcome, { tone: i.outcome === "passed" ? "success" : "danger" })}
                  <span class="muted small">${span(now - Date.parse(i.at))} ago</span>
                </li>`,
            )}
          </ul>`}`,
    { id: "out" },
  );
}

/** The most files the panel lists. */
const HOT_LISTED = 10;

/** Files several open pulls touch, most-touched first, from what `hot_files.ts` holds in memory. */
function hotFilesCard(app: App, reader: Reader): Html {
  const rows: { repo: string; path: string; pulls: number }[] = [];
  const repos = new Map<string, { name: string; ok: boolean } | undefined>();
  for (const w of warmFiles()) {
    if (!repos.has(w.repoId)) {
      const r = getRepoById(app.db, w.repoId);
      repos.set(w.repoId, r && { name: `${r.ownerName}/${r.name}`, ok: reader.kind === "owner" || r.visibility === "public" });
    }
    const repo = repos.get(w.repoId);
    if (repo?.ok) rows.push({ repo: repo.name, path: w.path, pulls: w.pulls });
  }
  rows.sort((a, b) => b.pulls - a.pulls || a.path.localeCompare(b.path) || a.repo.localeCompare(b.repo));
  const top = rows.slice(0, HOT_LISTED);
  const warming = warmingLine(app.db, Date.now(), pullCounts, reader.kind !== "owner").split("\n").filter((l) => l !== "");
  const max = Math.max(1, ...top.map((r) => r.pulls));
  return fold(
    "Hot files",
    top.length === 0 ? "no file is touched by 3 or more open pulls" : `${count(top.length)} ${top.length === 1 ? "file" : "files"} touched by 3 or more open pulls`,
    html`${top.length === 0
        ? html`<p class="muted">No file is touched by 3 or more open pulls.</p>`
        : html`<ul>
            ${top.map(
              (r) =>
                html`<li data-hot-file="${r.path}">
                  <span class="mono">${r.path}</span> <span class="muted small">${r.repo}</span>
                  <span class="mono" data-pulls>${String(r.pulls)}</span> open pulls
                  ${r.pulls >= HOT_PULLS ? badge("builds held", { tone: "danger" }) : null}
                  ${meter((r.pulls / max) * 100, `${r.pulls} open pulls touch ${r.path}`)}
                </li>`,
            )}
          </ul>`}
      ${warming.length === 0 ? null : html`<h3>Warming</h3><ul data-warming aria-label="Files warming up">${warming.map((l) => html`<li class="muted small">${l}</li>`)}</ul>`}`,
    { id: "hot-files" },
  );
}
