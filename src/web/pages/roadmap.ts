/**
 * The roadmap view of the map (#10303): the pillars in the order the crew
 * works them, one row each (the `row()` component, folded). One pace
 * sentence, what waits on the owner, then the pillars: the current one open,
 * the rest folded. A tap opens a pillar in place (a `<details>`, so no script);
 * the drawing stays one link away at `?view=graph`. A live region: the page
 * is swapped under the reader without losing their place or an open fold.
 */

import { html, type Html } from "../html.ts";
import { avatar, row } from "../ui.ts";
import { finishWords, paceSentence } from "../roadmap.ts";
import type {
  NeedsYou,
  Roadmap,
  RoadmapIssue,
  RoadmapPillar,
} from "../roadmap.ts";

export const roadmapCss = /* css */ `
.rm { display: grid; gap: 24px; margin-top: 4px; }
.rm-pace { margin: 0; }
.rm-group h3 { margin: 12px 0 4px; font-size: 13px; color: var(--muted); font-weight: 600; }
.rm-moved { margin-left: 6px; font-size: 11.5px; color: var(--muted); }
`;

function needs(base: string, rows: readonly NeedsYou[]): Html | null {
  if (rows.length === 0) return null;
  return html`<section id="rm-needs" aria-label="Needs you">
    <h2 class="small muted">Needs you</h2>
    <ul class="list">
      ${rows.map((r) =>
        row({
          title: r.text,
          nav: true,
          href: `${base}/${r.pull ? "pulls" : "issues"}/${r.number}`,
          trail: html`${r.action}`,
        }),
      )}
    </ul>
  </section>`;
}

function issueRow(base: string, i: RoadmapIssue): Html {
  const bits: string[] = [];
  if (i.pull !== undefined) bits.push(`pull #${i.pull}`);
  if (i.blockedBy !== undefined) bits.push(`waits for #${i.blockedBy.number} ${i.blockedBy.title}`);
  return row({
    ...(i.assignee === null ? {} : { lead: avatar(i.assignee) }),
    title: html`#${i.number} ${i.title}${i.moved ? html`<span class="rm-moved">moved</span>` : null}`,
    nav: true,
    href: `${base}/${i.pull === undefined ? "issues" : "pulls"}/${i.pull ?? i.number}`,
    ...(bits.length === 0 ? {} : { meta: html`${bits.join(" · ")}` }),
  });
}

function group(base: string, title: string, rows: readonly RoadmapIssue[]): Html | null {
  if (rows.length === 0) return null;
  return html`<section class="rm-group" data-group="${title}">
    <h3>${title} · ${rows.length}</h3>
    <ul class="list">${rows.map((i) => issueRow(base, i))}</ul>
  </section>`;
}

function meta(p: RoadmapPillar): string {
  if (p.state === "done") return "done";
  if (p.total === 0) return "nothing yet";
  return `${p.done} of ${p.total} done${p.state === "current" ? ` · ${finishWords(p.etaAt)}` : ""}`;
}

function pillarRow(base: string, p: RoadmapPillar): Html {
  const g = p.groups;
  const landed =
    g.doneThisWeek.length === 0 && p.lastLanding !== null && p.state !== "future"
      ? [p.lastLanding]
      : [];
  return row({
    id: `pillar-${p.short.toLowerCase()}`,
    title: html`${p.name}${p.movedCount > 0 ? html`<span class="rm-moved">${p.movedCount} moved</span>` : null}`,
    meta: html`${meta(p)}`,
    state: p.state === "done" ? "closed" : "open",
    data: { pillar: p.state },
    fold: {
      id: `pillar-${p.short.toLowerCase()}-fold`,
      open: p.state === "current",
      body: html`${group(base, "Building", g.building)}${group(base, "Up next", g.upNext)}${group(base, "Waiting on a pull", g.waiting)}${group(base, "Blocked", g.blocked)}${group(base, "Done this week", g.doneThisWeek)}${group(base, "Last landed", landed)}
        <p class="small muted">${p.umbrella === null ? null : html`<a href="${base}/issues/${p.umbrella}">The pillar's issue</a> · `}<a href="${base}/map?view=graph">Draw the graph</a></p>`,
    },
  });
}

/** The region's inner markup; the live swap replaces exactly this. */
export function roadmapBody(base: string, road: Roadmap): Html {
  return html`<p class="rm-pace" id="rm-pace">${paceSentence(road)}</p>${needs(base, road.needsYou)}
    <ul class="list" id="rm-pillars">${road.pillars.map((p) => pillarRow(base, p))}</ul>`;
}
