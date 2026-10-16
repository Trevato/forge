/**
 * /flow, for a forge admin: the pipeline from a ready issue to a live
 * deploy as rows, one per stage, each with how much is in it now, how long
 * its oldest waiting item has waited, and the capacity that limits it
 * (#1554). One sentence above names the stage with the longest wait — the
 * bottleneck. The numbers are `flow/pipeline.ts`'s; the knobs stay on
 * Settings → Capacity, linked from here.
 *
 * Beside what each stage holds, what it let out (#1779): items out in the
 * last hour and a 24-bar sparkline per stage, and a headline line of
 * landings and the median ask→live — `flow/throughput.ts`'s numbers, the
 * same ones the MCP `flow` tool and the terminal's Flow command read. Every
 * count links back here with `?out=<what>[&hour=<0–23>]`, which lists the
 * items it counted under the table.
 */

import { conflictedPulls, conflictedSays } from "../../flow/conflicted.ts";
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
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card } from "../ui.ts";

const css = /* css */ `
.flow-out { display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
.flow-out svg { width: 72px; height: 16px; }
.flow-bar { fill: var(--muted-fg); }
.flow-bar[data-empty] { fill: var(--muted); }
`;

/** What `?out=` and `?hour=` ask to list, checked: an unknown stage or hour lists nothing. */
function asked(url: URL): { key: PipelineKey; hour: number | null } | null {
  const key = stageOf(url.searchParams.get("out") ?? "");
  if (key === undefined) return null;
  const h = url.searchParams.get("hour");
  if (h === null) return { key, hour: null };
  if (!/^\d{1,2}$/.test(h) || Number(h) >= HOURS) return null;
  return { key, hour: Number(h) };
}

const outHref = (key: PipelineKey, hour: number | null): string =>
  `/flow?out=${OUTFLOW[key].out}${hour === null ? "" : `&hour=${hour}`}#out`;

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
    return html`<rect class="flow-bar" ${n === 0 ? html`data-empty` : null} x="${String(x)}" y="${String(16 - h)}" width="2" height="${String(h)}" />`;
  });
  return html`<svg viewBox="0 0 72 16" aria-hidden="true" focusable="false">${bars}</svg>`;
}

function outCell(t: StageThroughput): Html {
  const day = t.items.length;
  const passed = t.items.filter((i) => i.outcome === "passed").length;
  return html`<span class="flow-out" data-out="${OUTFLOW[t.key].out}">
      <a class="mono" href="${outHref(t.key, 0)}" data-hour="0">${String(t.hours[0] ?? 0)}</a>
      ${sparkline(t)}
      <a class="muted small" href="${outHref(t.key, null)}" data-day="${String(day)}">${String(day)} in 24 h</a>
    </span>
    <div class="muted small">
      ${OUTFLOW[t.key].label}${t.key === "checking" && day > 0 ? ` · ${passed} passed · ${day - passed} failed` : ""}
    </div>`;
}

// GET /flow
export function flowPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const now = Date.now();
  const stages = readPipeline(ctx.app.db, new Date(now));
  const worst = bottleneck(stages);
  const flow = readThroughput(ctx.app.db, stages.map((s) => s.key), new Date(now));
  const out = new Map(flow.stages.map((t) => [t.key, t]));
  const landed = out.get("approved");
  const conflicted = conflictedSays(conflictedPulls(ctx.app.db), now);
  const listed = asked(ctx.url);
  const shown = listed === null ? undefined : out.get(listed.key);
  const body = html`<div class="page-head">
      <h1>Flow</h1>
      <p class="muted">
        From a ready issue to a live deploy: what is in each stage now, how
        long its oldest has waited, and what limits it. The limits are set on
        <a href="/settings/capacity">Capacity</a> and in each repository's
        autonomy settings. How the forge stands against its threats is on
        <a href="/resilience">Resilience</a>.
      </p>
    </div>
    <p id="bottleneck" data-stage="${worst?.key ?? ""}">
      <strong>${verdict(stages, now)}</strong>
    </p>
    ${conflicted === null ? "" : html`<p id="conflicted">${conflicted}</p>`}
    <p id="throughput">
      landed
      <a href="${outHref("approved", 0)}" data-landed-hour>${String(landed?.hours[0] ?? 0)}</a>
      in the last hour ·
      <a href="${outHref("approved", null)}" data-landed-day>${String(landed?.items.length ?? 0)}</a>
      in 24 h · median ask→live
      <span data-median>${flow.medianAskToLiveMs === null ? "—" : hoursSpan(flow.medianAskToLiveMs)}</span>
      (24 h)
    </p>
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
                  <td class="mono">${String(s.active)}</td>
                  <td class="mono">${waited(s, now) ?? "—"}</td>
                  <td class="small">${s.capacity ?? "—"}</td>
                  <td>${outCell(out.get(s.key)!)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
      { pad: false },
    )}
    ${listed === null || shown === undefined ? null : outList(shown, listed.hour, now)}`;
  return page({ ctx, title: "Flow", body, styleCss: css });
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
