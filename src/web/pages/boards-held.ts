/**
 * The pipeline and the held counts as a panel of `/boards`: one row per
 * stage (`flow/pipeline.ts`) and, per autonomous repository, its ready list
 * as one bar with the count each filter holds (`flow/held.ts`). /flow draws
 * the same held card from here. A private repository is in the rows for the
 * owner only.
 */

import type { App } from "../../app.ts";
import { HOLDS } from "../../crew/held.ts";
import { readHeld, type HeldRow } from "../../flow/held.ts";
import { bottleneck, readPipeline, STAGE_HOLDS, STAGE_LABEL, verdict, waited } from "../../flow/pipeline.ts";
import { html, type Html } from "../html.ts";
import { badge, card } from "../ui.ts";

export const heldCss = /* css */ `
.held-bar { width: 100%; height: 12px; display: block; }
.held-key { display: inline-flex; align-items: center; gap: 4px; margin-right: 12px; font-variant-numeric: tabular-nums; }
.held-key svg { width: 10px; height: 10px; }
.held-startable { fill: var(--success); }
.held-running { fill: var(--accent); }
.held-open_pull { fill: var(--merged); }
.held-planner { fill: var(--primary); }
.held-done_on_main { fill: var(--add-fg); }
.held-stalled { fill: var(--attn); }
.held-run_cap { fill: var(--danger); }
.held-parked_twice { fill: var(--del-fg); }
.held-red_fix { fill: var(--muted-fg); }
.held-setting { fill: var(--border-strong); }
`;

/** One segment per kind, as wide as its share: a picture only; the counts beside it are the words. */
function heldBar(row: HeldRow): Html {
  const parts: [string, number][] = [
    ["startable", row.startable],
    ...HOLDS.map((h): [string, number] => [h, row.counts[h]]),
  ];
  const total = parts.reduce((n, [, c]) => n + c, 0);
  let x = 0;
  const rects = parts
    .filter(([, c]) => c > 0)
    .map(([kind, c]) => {
      const w = (c / total) * 100;
      const rect = html`<rect class="held-${kind}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="12" />`;
      x += w;
      return rect;
    });
  return html`<svg class="held-bar" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">${rects}</svg>`;
}

function heldKey(kind: string, n: number): Html {
  return html`<span class="held-key small" data-held="${kind}">
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><rect class="held-${kind}" width="10" height="10" /></svg>
    <span class="mono">${kind}=${String(n)}</span>
  </span>`;
}

/** Why ready issues cannot start, per autonomous repository (#2244). */
export function heldCard(rows: readonly HeldRow[]): Html {
  return card(
    html`<h2>Ready, and why it waits</h2>
      <p class="muted small">
        Each ready issue a builder could start, or the first filter that holds
        it: a run on it, an open pull, the planner, stalled, its run cap,
        parked twice, a red-main fix, a setting's finding. When nothing can
        start and builders are free, the planner is asked to re-plan what is
        stalled or capped.
      </p>
      ${rows.length === 0
        ? html`<p class="muted">No repository runs on its own.</p>`
        : rows.map(
            (r) => html`<div data-held-repo="${r.repo}">
              <p><a href="/${r.repo}/map">${r.repo}</a></p>
              ${heldBar(r)}
              <p>
                ${heldKey("startable", r.startable)}
                ${HOLDS.filter((h) => r.counts[h] > 0).map((h) => heldKey(h, r.counts[h]))}
              </p>
            </div>`,
          )}`,
    { id: "held" },
  );
}

/** The pipeline, a row per stage, under the sentence naming the bottleneck. */
function pipelineCard(app: App, now: number): Html {
  const stages = readPipeline(app.db, new Date(now));
  const worst = bottleneck(stages);
  return card(
    html`<p data-stage="${worst?.key ?? ""}"><strong>${verdict(stages, now)}</strong></p>
      <div class="table-scroll">
        <table class="table" aria-label="Pipeline stages">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Waiting</th>
              <th scope="col">Active</th>
              <th scope="col">Oldest wait</th>
              <th scope="col">Capacity</th>
            </tr>
          </thead>
          <tbody>
            ${stages.map(
              (s) => html`<tr data-stage="${s.key}" ${s === worst ? html`data-bottleneck="true"` : null}>
                <th scope="row">
                  ${STAGE_LABEL[s.key]}
                  ${s === worst ? badge("bottleneck", { tone: "danger" }) : null}
                  <div class="muted small">${STAGE_HOLDS[s.key]}</div>
                </th>
                <td class="mono">${String(s.waiting)}</td>
                <td class="mono">${String(s.active)}</td>
                <td class="mono">${waited(s, now) ?? "—"}</td>
                <td class="small">${s.capacity ?? "—"}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
    { head: html`<h2>Pipeline</h2>`, id: "pipeline", pad: false },
  );
}

/** The pipeline and the held counts; `owner` adds the private repositories. */
export function pipelinePanel(app: App, owner: boolean, now = Date.now()): Html {
  return html`${pipelineCard(app, now)}${heldCard(readHeld(app, owner, now))}`;
}
