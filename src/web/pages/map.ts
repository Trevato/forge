/**
 * The map: a repository's issues drawn by what waits for what. Each issue
 * sits one column right of everything it is blocked by, so the left edge is
 * what is ready now; the longest open chain is emphasised; issues that wait
 * for nothing and hold nothing up stand apart below. Beside the drawing: the
 * three lists the crew and a person both read — ready now, blocked on, the
 * critical path — and two weeks of open count over closed-per-day.
 *
 * Drawn on the server as SVG, laid out by hand: a plan bigger than the
 * few hundred issues this handles is not one a person reads.
 *
 * The global map at `/map` is the same drawing once per repository the
 * viewer can see, stacked: one canvas for every app, and where the crew is
 * marked on it.
 */

import type { App } from "../../app.ts";
import {
  blockedOn,
  criticalPath,
  levelAndFlow,
  readyNow,
  repoGraph,
  type DayPoint,
  type Graph,
  type Ranked,
} from "../../core/dependencies.ts";
import type { Issue } from "../../core/issues.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { listActiveRuns, type Run, type RunState } from "../../core/runs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  pageHead,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { icon } from "../ui.ts";
import { autonomyStatus, type AutonomyStatus } from "../../crew/autonomy.ts";

// ---- layout ----

interface Placed {
  readonly issue: Issue;
  readonly column: number;
  readonly row: number;
  /** In the island of dependency-free issues, below the chains. */
  readonly island: boolean;
}

export interface Layout {
  readonly nodes: Placed[];
  readonly columns: number;
  readonly rows: number;
  readonly islandRows: number;
}

/**
 * Longest-path layering: an issue's column is one more than the deepest of
 * its blockers. A cycle would never settle, so the relaxation is bounded
 * and a cycle simply lands in adjacent columns. Within a column, issues are
 * ordered by the mean row of their blockers (two sweeps), which is what
 * keeps the arrows short and mostly uncrossed.
 */
export function layout(graph: Graph): Layout {
  const ids = graph.issues.map((i) => i.id);
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const e of graph.edges) {
    blockers.set(e.issueId, [
      ...(blockers.get(e.issueId) ?? []),
      e.blockedById,
    ]);
    dependents.set(e.blockedById, [
      ...(dependents.get(e.blockedById) ?? []),
      e.issueId,
    ]);
  }
  const onEdge = new Set<string>([...blockers.keys(), ...dependents.keys()]);
  const column = new Map<string, number>(ids.map((id) => [id, 0]));
  const passes = Math.min(ids.length, 64);
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const id of ids) {
      const want = Math.max(
        0,
        ...(blockers.get(id) ?? []).map((b) => (column.get(b) ?? 0) + 1),
      );
      if (want > (column.get(id) ?? 0)) {
        column.set(id, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const chained = graph.issues.filter((i) => onEdge.has(i.id));
  const island = graph.issues.filter((i) => !onEdge.has(i.id));
  const columns = new Map<number, Issue[]>();
  for (const i of chained) {
    const c = column.get(i.id) ?? 0;
    columns.set(c, [...(columns.get(c) ?? []), i]);
  }
  const width = columns.size === 0 ? 0 : Math.max(...columns.keys()) + 1;
  const row = new Map<string, number>();
  for (let c = 0; c < width; c++)
    (columns.get(c) ?? []).forEach((i, r) => row.set(i.id, r));
  const mean = (list: string[]): number =>
    list.length === 0
      ? Number.POSITIVE_INFINITY
      : list.reduce((s, id) => s + (row.get(id) ?? 0), 0) / list.length;
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let c = 1; c < width; c++) {
      const list = columns.get(c) ?? [];
      list.sort((a, b) => {
        const ma = mean(blockers.get(a.id) ?? []);
        const mb = mean(blockers.get(b.id) ?? []);
        return ma - mb || a.number - b.number;
      });
      list.forEach((i, r) => row.set(i.id, r));
    }
    for (let c = width - 2; c >= 0; c--) {
      const list = columns.get(c) ?? [];
      list.sort((a, b) => {
        const ma = mean(dependents.get(a.id) ?? []);
        const mb = mean(dependents.get(b.id) ?? []);
        return ma - mb || a.number - b.number;
      });
      list.forEach((i, r) => row.set(i.id, r));
    }
  }
  const rows = Math.max(0, ...[...columns.values()].map((l) => l.length));
  const ISLAND_COLUMNS = Math.max(1, width || 4);
  const nodes: Placed[] = [
    ...chained.map((issue) => ({
      issue,
      column: column.get(issue.id) ?? 0,
      row: row.get(issue.id) ?? 0,
      island: false,
    })),
    ...island.map((issue, n) => ({
      issue,
      column: n % ISLAND_COLUMNS,
      row: rows + (rows > 0 ? 1 : 0) + Math.floor(n / ISLAND_COLUMNS),
      island: true,
    })),
  ];
  const islandRows = Math.ceil(island.length / ISLAND_COLUMNS);
  return {
    nodes,
    columns: Math.max(width, island.length > 0 ? ISLAND_COLUMNS : 0),
    rows: rows + (rows > 0 && islandRows > 0 ? 1 : 0) + islandRows,
    islandRows,
  };
}

// ---- drawing ----

const W = 184;
const H = 46;
const GX = 56;
const GY = 16;
const PAD = 14;

function trim(text: string, max = 24): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Where the crew is: each issue with an agent run in flight, by issue id.
 * A running run outranks a queued one on the same issue. Issue ids are
 * forge-wide, so one map serves every repository's drawing at once.
 */
export function crewMarks(runs: readonly Run[]): Map<string, RunState> {
  const marks = new Map<string, RunState>();
  for (const run of runs)
    if (run.issueId !== null && marks.get(run.issueId) !== "running")
      marks.set(run.issueId, run.state);
  return marks;
}

export interface Emphasis {
  readonly ready: Set<string>;
  readonly critical: Set<string>;
  /** Issues the crew is on right now; see `crewMarks`. */
  readonly crew: Map<string, RunState>;
}

export function drawMap(
  repo: Repo,
  graph: Graph,
  placed: Layout,
  emphasis: Emphasis,
): Html {
  if (placed.nodes.length === 0)
    return html`<div class="map-empty">
      ${icon("map", 20)}
      <p>No open issues to map. Open one, then link what it waits for.</p>
    </div>`;
  const base = repoBase(repo);
  const at = new Map(placed.nodes.map((n) => [n.issue.id, n]));
  const x = (c: number) => PAD + c * (W + GX);
  const y = (r: number) => PAD + r * (H + GY);
  const width =
    PAD * 2 + placed.columns * W + Math.max(0, placed.columns - 1) * GX;
  const height = PAD * 2 + placed.rows * H + Math.max(0, placed.rows - 1) * GY;
  const edges = graph.edges.map((e) => {
    const from = at.get(e.blockedById);
    const to = at.get(e.issueId);
    if (!from || !to) return null;
    const x1 = x(from.column) + W;
    const y1 = y(from.row) + H / 2;
    const x2 = x(to.column);
    const y2 = y(to.row) + H / 2;
    const bend = Math.max(24, (x2 - x1) / 2);
    const crit =
      emphasis.critical.has(e.issueId) && emphasis.critical.has(e.blockedById);
    return html`<path
      class="map-edge${crit ? " map-edge-crit" : ""}"
      d="M${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"
    />`;
  });
  const nodes = placed.nodes.map((n) => {
    const state =
      n.issue.state === "closed"
        ? "done"
        : emphasis.ready.has(n.issue.id)
          ? "ready"
          : "waiting";
    const px = x(n.column);
    const py = y(n.row);
    // The crew's marker: the studio's word for the run, and a dot while it
    // actually runs. Quiet on purpose; the node's colour still says ready.
    const run = emphasis.crew.get(n.issue.id);
    return html`<a
      class="map-node"
      data-state="${state}"
      data-crit="${emphasis.critical.has(n.issue.id) ? "1" : "0"}"
      ${run ? html`data-run="${run}"` : null}
      href="${base}/issues/${n.issue.number}"
    >
      <rect x="${px}" y="${py}" width="${W}" height="${H}" rx="7" />
      ${run === "running"
        ? html`<circle
            class="map-crew-dot"
            cx="${px + W - 13}"
            cy="${py + 13}"
            r="3.5"
          />`
        : null}
      <text class="map-title" x="${px + 12}" y="${py + 19}">
        ${trim(n.issue.title)}
      </text>
      <text class="map-sub" x="${px + 12}" y="${py + 35}">
        #${n.issue.number}
        ${n.issue.state === "closed"
          ? " · done"
          : state === "ready"
            ? " · ready"
            : ""}${n.issue.assigneeName ? ` · ${n.issue.assigneeName}` : ""}
        ${run
          ? html` ·
              <tspan class="map-crew"
                >${run === "running" ? "working" : "queued"}</tspan
              >`
          : null}
      </text>
    </a>`;
  });
  return html`<div class="map-scroll">
    <svg
      class="map-svg"
      viewBox="0 0 ${width} ${height}"
      width="${width}"
      height="${height}"
      role="img"
      aria-label="Issues of ${repo.name} laid out by what they wait for"
    >
      ${edges}${nodes}
    </svg>
  </div>`;
}

function rankedList(
  repo: Repo,
  title: string,
  items: Ranked[],
  say: (r: Ranked) => string,
  empty: string,
): Html {
  const base = repoBase(repo);
  return html`<section class="map-list">
    <h2>${title}</h2>
    ${items.length === 0
      ? html`<p class="muted small">${empty}</p>`
      : html`<ol>
          ${items.slice(0, 6).map(
            (r) =>
              html`<li>
                <a href="${base}/issues/${r.issue.number}">${r.issue.title}</a>
                <span class="muted small">#${r.issue.number} · ${say(r)}</span>
              </li>`,
          )}
        </ol>`}
  </section>`;
}

function chart(points: DayPoint[]): Html {
  const w = 300;
  const h = 84;
  const pad = 6;
  const maxOpen = Math.max(1, ...points.map((p) => p.open));
  const maxClosed = Math.max(1, ...points.map((p) => p.closed));
  const step = (w - pad * 2) / Math.max(1, points.length - 1);
  const line = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${(pad + i * step).toFixed(1)} ${(
          pad +
          (h - pad * 2) * (1 - p.open / maxOpen)
        ).toFixed(1)}`,
    )
    .join(" ");
  const barW = Math.max(3, step * 0.55);
  const bars = points.map((p, i) => {
    const bh = (h - pad * 2) * (p.closed / maxClosed);
    return html`<rect
      class="map-flow"
      x="${(pad + i * step - barW / 2).toFixed(1)}"
      y="${(h - pad - bh).toFixed(1)}"
      width="${barW.toFixed(1)}"
      height="${bh.toFixed(1)}"
    />`;
  });
  const last = points.at(-1);
  const closedTotal = points.reduce((s, p) => s + p.closed, 0);
  return html`<section class="map-list">
    <h2>Two weeks</h2>
    <svg
      class="map-chart"
      viewBox="0 0 ${w} ${h}"
      role="img"
      aria-label="Open issues as a line over issues closed per day as bars"
    >
      ${bars}
      <path class="map-level" d="${line}" />
    </svg>
    <p class="muted small">
      ${last?.open ?? 0} open now · ${closedTotal} closed in 14 days
    </p>
  </section>`;
}

export const mapCss = /* css */ `
.map-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 20px; align-items: start; }
@media (max-width: 860px) { .map-wrap { grid-template-columns: 1fr; } }
.map-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); padding: 4px; }
.map-svg { display: block; max-width: none; }
.map-node rect { fill: var(--muted); stroke: var(--border); }
.map-node[data-state="ready"] rect { fill: color-mix(in srgb, var(--accent) 14%, var(--bg)); stroke: var(--accent); }
.map-node[data-state="done"] rect { fill: color-mix(in srgb, var(--merged) 12%, var(--bg)); stroke: color-mix(in srgb, var(--merged) 60%, var(--border)); }
.map-node[data-crit="1"] rect { stroke-width: 2; }
.map-node:hover rect { stroke: var(--fg); }
.map-node text { font-family: var(--font); pointer-events: none; }
.map-title { font-size: 12.5px; font-weight: 560; fill: var(--fg); }
.map-sub { font-size: 11px; fill: var(--fg-muted, var(--fg)); opacity: .72; }
.map-crew { fill: var(--accent); }
.map-crew-dot { fill: var(--accent); }
.map-edge { fill: none; stroke: var(--border); stroke-width: 1.4; }
.map-edge-crit { stroke: var(--accent); stroke-width: 2; }
.map-list h2 { font-size: 13px; margin: 0 0 6px; }
.map-list ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-size: 13.5px; }
.map-list li span { display: block; }
.map-list + .map-list { margin-top: 18px; }
.map-chart { width: 100%; height: auto; display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); }
.map-level { fill: none; stroke: var(--accent); stroke-width: 1.6; }
.map-flow { fill: color-mix(in srgb, var(--merged) 45%, transparent); }
.map-empty { display: grid; justify-items: center; gap: 8px; padding: 40px 16px; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--fg); opacity: .8; text-align: center; }
.map-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; margin-top: 8px; opacity: .8; }
.map-legend i { display: inline-block; width: 14px; height: 10px; border-radius: 3px; border: 1px solid var(--border); vertical-align: -1px; margin-right: 5px; background: var(--muted); }
.map-legend i.ready { background: color-mix(in srgb, var(--accent) 14%, var(--bg)); border-color: var(--accent); }
.map-legend i.done { background: color-mix(in srgb, var(--merged) 12%, var(--bg)); }
.map-legend i.crit { border: 2px solid var(--accent); background: transparent; }
.map-legend i.crew { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); border-color: var(--accent); vertical-align: 0; }
.map-lane + .map-lane { margin-top: 28px; }
.map-lane-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; }
.map-lane-head h2 { font-size: 15px; margin: 0; }
.map-lane-head h2 a { color: inherit; }
`;

/** The swatches under a drawing: what each colour and mark means. */
function legend(): Html {
  return html`<div class="map-legend">
    <span><i class="ready"></i>ready now</span>
    <span><i></i>waiting</span>
    <span><i class="done"></i>done</span>
    <span><i class="crit"></i>critical path</span>
    <span><i class="crew"></i>the crew is on it</span>
  </div>`;
}

/** One line on how the repository runs itself, when it does. */
function autonomyLine(ctx: Ctx, repo: Repo): Html | null {
  if (repo.autonomy === "off") return null;
  const s = autonomyStatus(ctx.app, repo);
  const paused =
    s.paused === "ceiling"
      ? " · paused at the ceiling until 00:00 UTC"
      : s.paused === "no crew"
        ? " · paused: no crew"
        : s.paused === "nobody"
          ? " · paused: nobody to act as"
          : "";
  const line = `${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"} · $${s.spentTodayUsd.toFixed(2)} of $${s.ceilingUsd.toFixed(0)} today · ${s.active} of ${s.slots} slots${paused}`;
  return html`<p class="small map-autonomy">
    ${icon("play")} ${line} ·
    <a href="${repoBase(repo)}/settings/autonomy">settings</a>
  </p>`;
}

/** GET /:owner/:name/map */
export function mapPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const graph = repoGraph(ctx.app.db, repo.id);
  const ready = readyNow(graph);
  const blocked = blockedOn(graph);
  const critical = criticalPath(graph);
  const placed = layout(graph);
  const crew = crewMarks(listActiveRuns(ctx.app.db, [repo.id]));
  const body = html`${repoHeader(ctx, repo, "map")}
    <div class="page-head mt">
      <h1>Map</h1>
      <p class="muted">
        What waits for what. The left edge is ready now; the emphasised chain is
        the least work that still has to happen in order.
      </p>
      ${autonomyLine(ctx, repo)}
    </div>
    <div class="map-wrap">
      <div>
        ${drawMap(repo, graph, placed, {
          ready: new Set(ready.map((r) => r.issue.id)),
          critical: new Set(critical.map((i) => i.id)),
          crew,
        })}
        ${legend()}
      </div>
      <aside>
        ${graph.issues.length === 0
          ? null
          : rankedList(
              repo,
              "Ready now",
              ready,
              (r) =>
                r.holdsUp === 0
                  ? "holds nothing up"
                  : `finishing it frees ${r.holdsUp}`,
              "Nothing is ready: everything open waits for something.",
            )}
        ${rankedList(
          repo,
          "Blocked on",
          blocked,
          (r) => `holds up ${r.holdsUp}`,
          "Nothing open holds anything up.",
        )}
        ${critical.length > 1
          ? html`<section class="map-list">
              <h2>Critical path</h2>
              <ol>
                ${critical.map(
                  (i) =>
                    html`<li>
                      <a href="${repoBase(repo)}/issues/${i.number}"
                        >${i.title}</a
                      >
                    </li>`,
                )}
              </ol>
            </section>`
          : null}
        ${chart(levelAndFlow(ctx.app.db, repo.id))}
      </aside>
    </div>`;
  return page({
    ctx,
    title: `Map · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: mapCss,
  });
}

/**
 * The map as data, for the crew and the tick: the same three lists, and
 * `working`, the issues the crew is on right now.
 */
export function mapJson(
  repo: Repo,
  graph: Graph,
  crew: Map<string, RunState> = new Map(),
): Record<string, unknown> {
  const brief = (i: Issue) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    assignee: i.assigneeName,
  });
  return {
    repo: { owner: repo.ownerName, name: repo.name },
    ready: readyNow(graph).map((r) => ({
      ...brief(r.issue),
      holdsUp: r.holdsUp,
    })),
    blockedOn: blockedOn(graph).map((r) => ({
      ...brief(r.issue),
      holdsUp: r.holdsUp,
      waitsFor: r.waitsFor,
    })),
    critical: criticalPath(graph).map((i) => i.number),
    working: graph.issues.filter((i) => crew.has(i.id)).map((i) => i.number),
    issues: graph.issues.map(brief),
    edges: graph.edges.map((e) => {
      const a = graph.issues.find((i) => i.id === e.issueId);
      const b = graph.issues.find((i) => i.id === e.blockedById);
      return { issue: a?.number, blockedBy: b?.number };
    }),
  };
}

// ---- every app on one canvas ----

interface Lane {
  readonly repo: Repo;
  readonly graph: Graph;
  /** Agent runs queued or running here now. */
  readonly inFlight: number;
  /** Set when the repository runs itself; `off` has no spend to show. */
  readonly status: AutonomyStatus | undefined;
}

interface Lanes {
  readonly lanes: Lane[];
  readonly crew: Map<string, RunState>;
}

/**
 * One lane per repository the viewer can see that has something to draw:
 * an open issue, or a run in flight. The rest are left out rather than
 * drawn empty, so the page is as long as the work and no longer. One read
 * for every run in flight; a graph only for the lanes that stay.
 */
export function globalLanes(app: App, viewer: User | undefined): Lanes {
  const db = app.db;
  const repos = listReposVisibleTo(db, viewer, { limit: 200 });
  const runs = listActiveRuns(
    db,
    repos.map((r) => r.id),
  );
  const inFlight = new Map<string, number>();
  for (const run of runs)
    inFlight.set(run.repoId, (inFlight.get(run.repoId) ?? 0) + 1);
  const lanes: Lane[] = [];
  for (const repo of repos) {
    const flying = inFlight.get(repo.id) ?? 0;
    if ((repo.counts?.openIssues ?? 0) === 0 && flying === 0) continue;
    lanes.push({
      repo,
      graph: repoGraph(db, repo.id),
      inFlight: flying,
      status: repo.autonomy === "off" ? undefined : autonomyStatus(app, repo),
    });
  }
  return { lanes, crew: crewMarks(runs) };
}

/** A lane: the repository's name, how it runs itself, and its map. */
function laneHtml(lane: Lane, crew: Map<string, RunState>): Html {
  const { repo, graph, status } = lane;
  const spend =
    status === undefined
      ? ""
      : ` · $${status.spentTodayUsd.toFixed(2)} of $${status.ceilingUsd.toFixed(0)} today`;
  const flying =
    lane.inFlight === 0
      ? ""
      : ` · ${lane.inFlight} ${lane.inFlight === 1 ? "run" : "runs"} in flight`;
  return html`<section class="map-lane">
    <header class="map-lane-head">
      <h2>
        <a href="${repoBase(repo)}/map">${repo.ownerName}/${repo.name}</a>
      </h2>
      <span class="muted small">${repo.autonomy}${spend}${flying}</span>
    </header>
    ${drawMap(repo, graph, layout(graph), {
      ready: new Set(readyNow(graph).map((r) => r.issue.id)),
      critical: new Set(criticalPath(graph).map((i) => i.id)),
      crew,
    })}
  </section>`;
}

/** GET /map — every app the viewer can see, one lane each. */
export function globalMapPage(ctx: Ctx): Response {
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  const { lanes, crew } = globalLanes(ctx.app, viewer);
  const body = html`${pageHead("Map", {
    sub: "Every app you can see, laid out by what waits for what. The left edge of each lane is ready now; a marked issue is where the crew is.",
  })}
  ${lanes.length === 0
    ? html`<p class="muted">
        Nothing to map: no open issues anywhere you can see, and nobody working.
      </p>`
    : html`${lanes.map((lane) => laneHtml(lane, crew))} ${legend()}`}`;
  return page({ ctx, title: "Map", body, styleCss: mapCss });
}

/** GET /api/v1/map — the lanes as data, one entry per repository. */
export function globalMapJson(
  app: App,
  viewer: User | undefined,
): Record<string, unknown> {
  const { lanes, crew } = globalLanes(app, viewer);
  return {
    repos: lanes.map((lane) => ({
      ...mapJson(lane.repo, lane.graph, crew),
      autonomy: lane.repo.autonomy,
      spentTodayUsd: lane.status?.spentTodayUsd ?? null,
      inFlight: lane.inFlight,
    })),
  };
}
