/**
 * The flow panel, drawn for /boards: the pipeline with what each
 * stage let out, the bottleneck sentence, conflicted and requested pulls,
 * throughput, duplicate test work, why ready issues wait, and the merge
 * queue (the numbers come from `src/flow`). `/boards` shows it
 * to the owner; the old `/flow` redirects here. Every
 * count links back to the page that drew it with `?out=<what>[&hour=<0–23>]`.
 */

import type { Reader } from "../../actions/telemetry.ts";
import { queuesFor, systemFor } from "../../system/telemetry.ts";
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
  hoursSpan,
  HOURS,
  itemsIn,
  OUTFLOW,
  readThroughput,
  stageOf,
  type StageThroughput,
} from "../../flow/throughput.ts";
import { type QueueRow, redBatchWords } from "../../flow/queue.ts";
import { HOT_PULLS, pullCounts, warmFiles } from "../../crew/hot_files.ts";
import { warmingLine } from "../../crew/hot_history.ts";
import { getRepoById } from "../../core/repos.ts";
import { IDLE_LIMIT, type IdlePull } from "../../flow/idle_pulls.ts";
import { panelFigures } from "../../flow/panel_cache.ts";
import { hoursWords } from "../../flow/lead_time.ts";
import { buildYieldSays } from "../../flow/build_yield.ts";
import { DECLINE_LABELS, DECLINE_REASONS } from "../../flow/declines.ts";
import { reviewLatencySays } from "../../flow/review_latency.ts";
import { openerCounts } from "../../flow/openers.ts";
import { readRepeats, type Repeats } from "../../flow/repeats.ts";
import { readHeld } from "../../flow/held.ts";
import { readVerified, verifiedSays, type VerifiedRow } from "../../flow/verified.ts";
import type { App } from "../../app.ts";
import { html, type Html } from "../html.ts";
import { keeperRow } from "../studio/keeper_row.ts";
import { gatesSection } from "./boards-gates.ts";
import { heldCard } from "./boards-held.ts";
import { badge, card, meter } from "../ui.ts";

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
function sparkline(t: StageThroughput): Html {
  const max = Math.max(1, ...t.hours);
  const bars = t.hours.map((n, hour) => {
    const x = (HOURS - 1 - hour) * 3;
    const h = n === 0 ? 1 : Math.max(2, Math.round((n / max) * 16));
    return html`<rect ${n === 0 ? html`fill-opacity="0.3"` : null} x="${String(x)}" y="${String(16 - h)}" width="2" height="${String(h)}" />`;
  });
  return html`<svg class="muted" viewBox="0 0 72 16" width="72" height="16" fill="currentColor" aria-hidden="true" focusable="false">${bars}</svg>`;
}

function outCell(base: string, t: StageThroughput): Html {
  const day = t.items.length;
  const passed = t.items.filter((i) => i.outcome === "passed").length;
  return html`<span class="bar num" data-out="${OUTFLOW[t.key].out}">
      <a class="mono" href="${outHref(base, t.key, 0)}" data-hour="0">${String(t.hours[0] ?? 0)}</a>
      ${sparkline(t)}
      <a class="muted small" href="${outHref(base, t.key, null)}" data-day="${String(day)}">${String(day)} in 24 h</a>
    </span>
    <div class="muted small">
      ${OUTFLOW[t.key].label}${t.key === "checking" && day > 0 ? ` · ${passed} passed · ${day - passed} failed` : ""}
    </div>`;
}

/** The panel for `reader`; `base` is the page it sits on, where its counts link. */
export function flowPanel(app: App, reader: Reader, url: URL, base: string): Html {
  const now = Date.now();
  const stages = readPipeline(app.db, new Date(now));
  const worst = bottleneck(stages);
  const flow = readThroughput(app.db, stages.map((s) => s.key), new Date(now));
  const out = new Map(flow.stages.map((t) => [t.key, t]));
  const landed = out.get("approved");
  const dups = systemFor(app, reader).duplicates;
  const fig = panelFigures(app.db, reader.kind, new Date(now));
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
  return html`${keeperRow(app.db, reader.kind === "owner")}${card(
      html`<p id="bottleneck" data-stage="${worst?.key ?? ""}">
          <strong>${verdict(stages, now)}</strong>
        </p>
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
    <p id="throughput">
      landed
      <a href="${outHref(base, "approved", 0)}" data-landed-hour>${String(landed?.hours[0] ?? 0)}</a>
      in the last hour ·
      <a href="${outHref(base, "approved", null)}" data-landed-day>${String(landed?.items.length ?? 0)}</a>
      in 24 h · median ask→live
      <span data-median>${flow.medianAskToLiveMs === null ? "—" : hoursSpan(flow.medianAskToLiveMs)}</span>
      (24 h)
    </p>
    <p id="lead-time" class="muted">
      time to land:
      ${lead.medianHours === null
        ? "nothing landed in 24 h"
        : html`median <span data-median-hours>${hoursWords(lead.medianHours)}</span>, slowest <span data-max-hours>${hoursWords(lead.maxHours ?? 0)}</span>`}
    </p>
    <p id="build-yield" class="muted">${buildYieldSays(yielded)}</p>
    ${fig.declined.says === ""
      ? ""
      : html`<p id="declines" class="muted">Declined in 24 h: ${DECLINE_REASONS.filter((r) => fig.declined.groups[r].count > 0).map(
          (r, i) => html`${i === 0 ? "" : ", "}<span data-reason="${r}">${String(fig.declined.groups[r].count)} ${DECLINE_LABELS[r]}</span> (${fig.declined.runs[r].map(
            (x, j) => html`${j === 0 ? "" : ", "}<a href="/${x.repo}/runs/${x.runId}">#${String(x.issue)}</a>`,
          )}${fig.declined.groups[r].distinct > fig.declined.runs[r].length ? ", …" : ""})`,
        )}</p>`}
    <p id="review-latency" class="muted">${reviewLatencySays(latency)}</p>
    <p id="openers" class="muted small">
      opened in the last hour:
      ${openers.length === 0
        ? "no pulls"
        : openers.map((o, i) => html`${i === 0 ? "" : " · "}<a href="/${o.author}">${o.author}</a> ${openerCounts(o)}`)}
    </p>
    <p id="duplicate-work" data-count="${String(dups.length)}" class="${dups.length === 0 ? "muted" : ""}">
      ${dups.length === 0
        ? html`No test file is running in more than one check.`
        : html`<strong>${String(dups.length)} test file${dups.length === 1 ? " is" : "s are"} running in more than one check:</strong>
          ${dups.slice(0, 5).map((d) => html`<span class="mono small">${d.file} (${d.checks.join(", ")})</span> `)}`}
      <a href="/system">System</a>
    </p>
    <p class="muted small">
      Limits are set on <a href="/settings/capacity">Capacity</a>. How the forge stands against its threats is on
      <a href="/resilience">Resilience</a>; where an outside agent can help is on <a href="/contribute">Contribute</a>.
    </p>`,
      { id: "flow-summary" },
    )}
    ${card(
      html`<div class="table-scroll">
        <table class="table" aria-label="Pipeline stages">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Waiting</th>
              <th scope="col">Active</th>
              <th scope="col">Oldest wait</th>
              <th scope="col">Capacity</th>
              <th scope="col">Out, last hour · 24 h</th>
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
                    <div class="muted small">${STAGE_HOLDS[s.key]}</div>
                  </th>
                  <td class="mono">${String(s.waiting)}</td>
                  <td class="mono">${s.key === "live" ? "—" : String(s.active)}</td>
                  <td class="mono">${waited(s, now) ?? "—"}</td>
                  <td class="small">${s.capacity ?? "—"}</td>
                  <td>${outCell(base, out.get(s.key)!)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
      { head: html`<h2>Pipeline</h2><a class="muted small" href="/pipeline">The four steps</a><a class="muted small" href="/settings/capacity">Capacity</a>`, id: "pipeline", pad: false },
    )}
    ${repeatsCard(readRepeats(app.db, "", new Date(now), reader.kind !== "owner"))}
    ${verifiedCard(readVerified(app, reader.kind === "owner"), now)}
    ${hotFilesCard(app, reader)}
    ${heldCard(readHeld(app, reader.kind === "owner", now))}
    ${queueCard(queuesFor(app, reader, new Date(now), { batches: true }))}
    ${gatesSection(app.db, reader.kind === "owner", now)}
    ${url.searchParams.get("idle") === "all" && idle.length > 0 ? idleList(idle) : null}
    ${listed === null || shown === undefined ? null : outList(shown, listed.hour, now)}`;
}

/** What reviewers repeated (#8716): the proposals and retirements, beside comments per pull. */
function repeatsCard(r: Repeats): Html {
  return card(
    html`<h2>Review repeats</h2>
      <p data-repeats data-scope="${r.scope}">${r.says}.</p>
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
  return card(
    html`<h2>Verified after landing</h2>
      ${rows.length === 0
        ? html`<p class="muted">No repository verifies its main after landing yet: it declares <span class="mono">check.verify</span> in forge.json.</p>`
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
  return card(
    html`<h2>Merge queue</h2>
      <p class="muted small">
        Green, approved pulls join their repository's queue; each candidate
        is gated once and lands whole, or is searched for the red one. Where
        check slots are free the next candidate gates on top of this one, and
        a red one's halves gate at once. A pull found red is re-checked alone
        before it rides with others again.
      </p>
      ${rows.length === 0
        ? html`<p class="muted">Nothing queued, gating or landed in the last hour.</p>`
        : html`<div class="table-scroll">
            <table class="table" aria-label="Merge queue">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Queued</th>
                  <th scope="col">Gating</th>
                  <th scope="col">Gates</th>
                  <th scope="col">Landed, last hour</th>
                  <th scope="col">Approved to landed</th>
                  <th scope="col">Red batches, last hour</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) =>
                    html`<tr data-queue="${r.repo}">
                      <th scope="row"><a href="/${r.repo}/pulls">${r.repo}</a></th>
                      <td class="mono" data-queued>${String(r.queued)}</td>
                      <td class="mono" data-gating>${String(r.gating)}</td>
                      <td class="mono" data-gates>${String(r.gates)}</td>
                      <td class="mono" data-landed>${String(r.landedHour)}</td>
                      <td class="mono" data-approved-to-landed>${r.approvedToLanded === null ? "—" : `${r.approvedToLanded} min`}</td>
                      <td class="mono" data-red-batches>${redBatchWords(r)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`}`,
    { id: "queue" },
  );
}

/** The items one count counted, newest first, each linked to where it lives. */
function outList(t: StageThroughput, hour: number | null, now: number): Html {
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
  return card(
    html`<h2>Hot files</h2>
      ${top.length === 0
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
