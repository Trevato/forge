/**
 * The global map at `/map`: the repository map's drawing once per
 * repository the viewer can see, one lane each, at one scale, so a column
 * means the same thing in every lane. Its JSON at `/api/v1/map` is the same
 * lanes as data. The drawing itself — layout, cards, edges, words — is
 * map.ts's; this file only gathers the lanes and lays them out in a list.
 */

import type { App } from "../../app.ts";
import { autonomyStatus, type AutonomyStatus } from "../../crew/autonomy.ts";
import {
  criticalPath,
  readyNow,
  repoGraph,
  type Graph,
  type Ranked,
} from "../../core/dependencies.ts";
import type { Issue } from "../../core/issues.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { listActiveRuns, reposWithActiveRuns } from "../../core/runs.ts";
import { mayViewId, sealedScope } from "../../core/sealed.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { pageHead, repoBase, signInFirst } from "../chrome.ts";
import { liveRegionsJs } from "../client.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { cachedLane, cachedLayout, repoHeads, scopeKey } from "../map_cache.ts";
import { avatar, badge, icon, listCard, row } from "../ui.ts";
import {
  countsLine,
  countWords,
  drawingWidth,
  drawMap,
  emphasisFor,
  layout,
  LIVE_KINDS,
  mapCss,
  mapJson,
  mapViewJs,
  marksFor,
  wordFor,
  type Layout,
  type Marks,
  type Word,
} from "./map.ts";

export interface Lane {
  readonly repo: Repo;
  readonly graph: Graph;
  readonly placed: Layout;
  readonly marks: Marks;
  readonly ready: Ranked[];
  readonly critical: Issue[];
  readonly counts: Record<Word, number>;
  /** Agent runs queued or running here now. */
  readonly inFlight: number;
  /** Who those runs are: usernames, the running ones first. */
  readonly workers: string[];
  /** Nothing in flight and nothing ready: the lane folds to its header. */
  readonly idle: boolean;
  /** Set when the repository runs itself; `off` has no spend to show. */
  readonly status: AutonomyStatus | undefined;
}

/** A lane as kept: everything but the repository and the workers' names. */
type KeptLane = Omit<Lane, "repo" | "workers"> & {
  /** The runs' actors, running ones first; their names are read per request. */
  readonly workerIds: string[];
};

/** Milliseconds a request spent laying graphs out, inside the lanes' build. */
export interface Spent {
  layoutMs: number;
}

function timed<T>(spent: Spent | undefined, run: () => T): T {
  if (spent === undefined) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    spent.layoutMs += performance.now() - started;
  }
}

/**
 * One repository's lane for one scope, or null when it has nothing to draw.
 * Every read of issues here respects `scope`, so the entry it becomes is
 * the same for everyone whose scope computes to the same key.
 */
function buildLane(
  app: App,
  repo: Repo,
  viewer: User | undefined,
  scope: ReturnType<typeof sealedScope>,
  spent?: Spent,
): KeptLane | null {
  const db = app.db;
  // A run on a sealed report is not shown to who may not see the report.
  const flying = listActiveRuns(db, [repo.id]).filter((r) =>
    mayViewId(db, repo, r.issueId, viewer),
  );
  if ((repo.counts?.openIssues ?? 0) === 0 && flying.length === 0) return null;
  const graph = repoGraph(db, repo.id, scope);
  const marks = marksFor(db, repo.id, graph, flying);
  const ready = readyNow(graph);
  const readySet = new Set(ready.map((r) => r.issue.id));
  const workerIds = [
    ...new Set(
      [...flying]
        .sort(
          (a, b) =>
            (a.state === "running" ? -1 : 0) - (b.state === "running" ? -1 : 0),
        )
        .map((r) => r.actorId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const counts = countWords(
    graph.issues.map((i) => wordFor(i, readySet, marks)),
  );
  return {
    graph,
    placed: timed(spent, () => cachedLayout(graph, layout)),
    marks,
    ready,
    critical: criticalPath(graph),
    counts,
    inFlight: flying.length,
    workerIds,
    // Nothing in flight and no card that says ready: a parked or proposed
    // issue is not one a free slot would take.
    idle: flying.length === 0 && counts.ready === 0,
    status: repo.autonomy === "off" ? undefined : autonomyStatus(app, repo),
  };
}

/**
 * One lane per repository the viewer can see that has something to draw:
 * an open issue, or a run in flight. The rest are left out rather than
 * drawn empty, so the page is as long as the work and no longer. One read
 * for every run in flight and one for who runs them; a graph and its marks
 * only for the lanes that stay.
 */
export function globalLanes(
  app: App,
  viewer: User | undefined,
  spent?: Spent,
): Lane[] {
  const db = app.db;
  const now = new Date();
  // Access first, every request, and into the key (docs/CACHING.md rule 1).
  const repos = listReposVisibleTo(db, viewer, { limit: 200, withoutArchived: true });
  const heads = repoHeads(
    db,
    repos.map((r) => r.id),
  );
  const running = reposWithActiveRuns(db, repos.map((r) => r.id));
  const built: { repo: Repo; lane: KeptLane }[] = [];
  for (const repo of repos) {
    // Nothing open and nobody running: no lane for anyone, so no scope to work out.
    if ((repo.counts?.openIssues ?? 0) === 0 && !running.has(repo.id)) continue;
    const scope = sealedScope(db, repo, viewer);
    const lane = cachedLane(
      {
        repoId: repo.id,
        head: heads.get(repo.id) ?? 0,
        scope: scopeKey(scope),
        now,
      },
      () => buildLane(app, repo, viewer, scope, spent),
    );
    if (lane !== null) built.push({ repo, lane });
  }
  // Names are read now, not kept: a renamed account shows on the next view.
  const actors = getUsersByIds(
    db,
    built.flatMap(({ lane }) => lane.workerIds),
  );
  const lanes: Lane[] = built.map(({ repo, lane }) => {
    const { workerIds, ...rest } = lane;
    return {
      ...rest,
      repo,
      workers: [
        ...new Set(
          workerIds
            .map((id) => actors.get(id)?.username)
            .filter((n): n is string => n !== undefined),
        ),
      ],
    };
  });
  // Where the crew is first, then what has work ready, idle lanes last;
  // by name within each, so the page reads the same twice.
  return lanes.sort(
    (a, b) =>
      Number(b.inFlight > 0) - Number(a.inFlight > 0) ||
      Number(a.idle) - Number(b.idle) ||
      b.counts.ready - a.counts.ready ||
      `${a.repo.ownerName}/${a.repo.name}`.localeCompare(
        `${b.repo.ownerName}/${b.repo.name}`,
      ),
  );
}

/** A lane: one folding list row — the caret, the repository's name and its
 * autonomy mode, who is on it, its counts — over its map. */
export function laneHtml(lane: Lane, width: number, drawn = false): Html {
  const { repo } = lane;
  const name = `${repo.ownerName}/${repo.name}`;
  return row({
    lead: icon("chevronRight"),
    title: html`<a href="${repoBase(repo)}/map"
        ><span class="muted">${repo.ownerName}/</span>${repo.name}</a
      >
      ${badge(repo.autonomy, { variant: "outline" })}`,
    // The way to the drawing is in the row itself, so a folded lane is one
    // tap from its graph; a drawn lane says so and offers the way back.
    meta: html`${countsLine(lane.counts)} ·
      ${drawn
        ? html`<a href="/map#lane-${repo.ownerName}-${repo.name}">Show fewer</a>`
        : html`<a href="/map?lane=${name}#lane-${repo.ownerName}-${repo.name}"
            >Draw ${lane.graph.issues.length} issues</a
          >`}`,
    trail:
      lane.workers.length === 0
        ? html``
        : html`<span title="Working: ${lane.workers.join(", ")}"
            >${lane.workers.slice(0, 5).map((w) => html`${avatar(w)} `)}${lane
              .workers.length > 5
              ? html`<span class="muted small"
                  >+${lane.workers.length - 5}</span
                >`
              : null}</span
          >`,
    data: lane.idle
      ? { autonomy: repo.autonomy, idle: "1" }
      : { autonomy: repo.autonomy },
    fold: {
      id: `lane-${repo.ownerName}-${repo.name}`,
      open: drawn || !lane.idle,
      // The drawing is the heavy part (megabytes across every lane): the
      // first screen carries the headers and the next things, and a lane's
      // graph comes when asked for, at `?lane=owner/name`.
      body: !drawn
        ? html`<p class="muted small">
            Drawn on request: <a href="/map?lane=${name}#lane-${repo.ownerName}-${repo.name}">draw it here</a>
            or <a href="${repoBase(repo)}/map">open its own map</a>.
          </p>`
        : drawMap(
        repo,
        lane.graph,
        lane.placed,
        emphasisFor(lane.ready, lane.critical, lane.marks),
        {
          id: `map-canvas-${repo.ownerName}-${repo.name}`,
          minWidth: width,
          cap: 0.6,
        },
      ),
    },
  });
}

/** `owner/name` as the `?lane=` of `/map` names it, or undefined: capped, and
 * made of the characters a repository path is made of, nothing else. */
export function parseLane(raw: string | null): string | undefined {
  if (raw === null || raw.length > 200) return undefined;
  return /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(raw) ? raw : undefined;
}

/** How many next things the first screen names. */
export const NEXT_COUNT = 5;

/** The next things across the lanes, the crew's lanes first (lane order). */
export function nextThings(lanes: readonly Lane[], n = NEXT_COUNT): Html {
  const picked = lanes
    .flatMap((lane) => lane.ready.map((r) => ({ lane, r })))
    .slice(0, n);
  if (picked.length === 0) return html``;
  return html`<h2>Next</h2>
    ${listCard(
      picked.map(({ lane, r }) =>
        row({
          href: `${repoBase(lane.repo)}/issues/${r.issue.number}`,
          title: r.issue.title,
          meta: html`${lane.repo.ownerName}/${lane.repo.name} #${r.issue.number}
            · ${lane.counts.ready} ready there${lane.inFlight > 0
              ? html` · crew working`
              : null}`,
        }),
      ),
    )}`;
}

/** GET /map — every app the viewer can see, one lane each. */
export function globalMapPage(ctx: Ctx): Response {
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  const { request } = ctx;
  notePhase(request, "session", takeSessionTime(request));
  const spent: Spent = { layoutMs: 0 };
  const lanesStart = performance.now();
  const lanes = globalLanes(ctx.app, viewer, spent);
  const lanesMs = performance.now() - lanesStart;
  notePhase(request, "lanes", Math.max(0, lanesMs - spent.layoutMs));
  notePhase(request, "layout", spent.layoutMs);
  const renderStart = performance.now();
  const width = Math.max(0, ...lanes.map((l) => drawingWidth(l.placed)));
  const want = parseLane(ctx.url.searchParams.get("lane"));
  const body = html`${pageHead("Map", {
      sub: "Every app you can see, laid out by what waits for what. The top edge of each lane is ready now; a ringed card is where the crew is.",
    })}
    ${nextThings(lanes)}
    <div id="lanes" data-live="${LIVE_KINDS}">
      ${lanes.length === 0
        ? html`<p class="muted">
            Nothing to map: no open issues anywhere you can see, and nobody
            working.
          </p>`
        : listCard(
            lanes.map((lane) =>
              laneHtml(
                lane,
                width,
                want === `${lane.repo.ownerName}/${lane.repo.name}`,
              ),
            ),
          )}
    </div>`;
  const response = page({
    ctx,
    title: "Map",
    body,
    styleCss: mapCss,
    scriptJs: `${liveRegionsJs}\n${mapViewJs}`,
  });
  notePhase(request, "render", performance.now() - renderStart);
  return response;
}

/** GET /api/v1/map — the lanes as data, one entry per repository. */
export function globalMapJson(
  app: App,
  viewer: User | undefined,
): Record<string, unknown> {
  return {
    repos: globalLanes(app, viewer).map((lane) => ({
      ...mapJson(lane.repo, lane.graph, lane.marks),
      autonomy: lane.repo.autonomy,
      spentTodayUsd: lane.status?.spentTodayUsd ?? null,
      ceilingUsd: lane.status?.ceilingUsd ?? null,
      inFlight: lane.inFlight,
      workers: lane.workers,
      idle: lane.idle,
    })),
  };
}
