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
import { conflictedPulls, conflictedSays, rebaseLane, rebaseLaneSays } from "../../flow/conflicted.ts";
import { reviewersBusy, reviewingSays } from "../../flow/reviewing.ts";
import { requestedSays, requestedWaits } from "../../flow/requested.ts";
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
import { readHeld } from "../../flow/held.ts";
import type { App } from "../../app.ts";
import { html, type Html } from "../html.ts";
import { heldCard } from "./boards-held.ts";
import { badge, card } from "../ui.ts";

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
  const conflictedList = conflictedPulls(app.db, reader.kind === "agent");
  const conflicted = conflictedSays(conflictedList, now);
  const lane = rebaseLaneSays(rebaseLane(app.db, conflictedList));
  const requested = requestedWaits(app.db, reader.kind === "agent");
  const onBuilder = requestedSays(requested.builder, "builder", now);
  const onReviewer = requestedSays(requested.reviewer, "reviewer", now);
  const reviewing = reviewingSays(reviewersBusy(app.db, reader.kind === "agent"));
  const listed = asked(url);
  const shown = listed === null ? undefined : out.get(listed.key);
  return html`${card(
      html`<p id="bottleneck" data-stage="${worst?.key ?? ""}">
          <strong>${verdict(stages, now)}</strong>
        </p>
    ${lane === null ? "" : html`<p id="rebase-lane">Rebases: ${lane}.</p>`}
    ${conflicted === null ? "" : html`<p id="conflicted">${conflicted}</p>`}
    ${onBuilder === null ? "" : html`<p id="requested-builder">${onBuilder}</p>`}
    ${onReviewer === null ? "" : html`<p id="requested-reviewer">${onReviewer}</p>`}
    ${reviewing === null ? "" : html`<p id="review-load">${reviewing}</p>`}
    <p id="throughput">
      landed
      <a href="${outHref(base, "approved", 0)}" data-landed-hour>${String(landed?.hours[0] ?? 0)}</a>
      in the last hour ·
      <a href="${outHref(base, "approved", null)}" data-landed-day>${String(landed?.items.length ?? 0)}</a>
      in 24 h · median ask→live
      <span data-median>${flow.medianAskToLiveMs === null ? "—" : hoursSpan(flow.medianAskToLiveMs)}</span>
      (24 h)
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
      { head: html`<h2>Pipeline</h2><a class="muted small" href="/settings/capacity">Capacity</a>`, id: "pipeline", pad: false },
    )}
    ${heldCard(readHeld(app, reader.kind === "owner", now))}
    ${queueCard(queuesFor(app, reader, new Date(now), { batches: true }))}
    ${listed === null || shown === undefined ? null : outList(shown, listed.hour, now)}`;
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
