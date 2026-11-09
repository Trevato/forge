/**
 * The map: a repository's issues drawn by what waits for what. Each issue is
 * a card one level below everything it is blocked by, so the top edge is
 * what is ready now and the longest open chain runs down the page in the
 * accent. Issues that wait for nothing and hold nothing up stand apart
 * below, under a rule. Beside the drawing: open work by pillar and the two
 * lists the crew and a person both read — ready now and blocked on.
 *
 * One language for every map. A card says its title, who is on it, and one
 * word: ready, working, blocked, done, parked, or waiting. Edges are calm
 * curves from the bottom of a card to the top of the next; the critical path
 * is the accent at the same weight, never louder. The drawing fits its
 * container, pans and zooms, and is a live region: a card turns to working,
 * a pull lands, or a new issue appears while the page is open.
 *
 * Drawn on the server as SVG, laid out by hand: a plan bigger than the few
 * hundred issues this handles is not one a person reads. The global map at
 * `/map` (global-map.ts) is the same drawing once per repository the viewer
 * can see, one lane each.
 */

import type { MapHold } from "../../crew/held.ts";
import { sealedScope } from "../../core/sealed.ts";
import type { Database } from "bun:sqlite";
import {
  blockedOn,
  criticalPath,
  idleFurniture,
  readyNow,
  repoGraph,
  type Edge,
  type Graph,
  type Ranked,
} from "../../core/dependencies.ts";
import type { Issue } from "../../core/issues.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { cachedLayout } from "../map_cache.ts";
import { holdsFor } from "../../core/holds.ts";
import { firstMarksInRepo } from "../../core/first.ts";
import { canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { listActiveRuns, type Run, type RunState } from "../../core/runs.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
} from "../chrome.ts";
import { liveRegionsJs } from "../client.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, empty, row } from "../ui.ts";
import {
  parkedTwice,
  struckOut,
  type ParkedTwice,
} from "../../crew/parks.ts";
import {
  proposedWork,
  READER_SUGGESTION,
} from "../../crew/direct.ts";
import { studioRecord, tellHref } from "../studio/nouns.ts";
import { milestoneHref } from "./milestones.ts";
import {
  type AskToLive,
  type AskToLiveCount,
  isStructural,
  LATER,
  NO_PILLAR,
  PILLAR_DAYS,
  PLAN_OWN,
  pillarView,
  type PillarView,
} from "../../core/pillars.ts";
import { askToLiveFor } from "../ask_to_live.ts";

/** Where a card's own link goes: dev's issue page, by default. */
const devIssueHref = (base: string, number: number): string =>
  `${base}/issues/${number}`;

// ---- layout ----

interface Placed {
  readonly issue: Issue;
  /** Depth: one below the deepest blocker. Level 0 is the top edge. */
  readonly level: number;
  /** Position within the level, left to right. */
  readonly slot: number;
  /** In the island of dependency-free issues, below the chains. */
  readonly island: boolean;
}

/** A spot in the grid a long edge passes through, between its cards. */
export interface Via {
  readonly level: number;
  /** The gutter it runs down: `g` is between slot `g - 1` and slot `g`. */
  readonly gutter: number;
  /** Which of the lines sharing that gutter this one is, left to right. */
  readonly lane: number;
  readonly lanes: number;
}

/** An edge that skips levels, and the empty slots it is routed through. */
export interface Route {
  readonly issueId: string;
  readonly blockedById: string;
  readonly via: Via[];
}

export interface Layout {
  readonly nodes: Placed[];
  /** The edges that skip levels, with the slots they pass through. */
  readonly routes: Route[];
  /** Levels of chained issues, then the island's rows. */
  readonly levels: number;
  /** The widest level, in slots. */
  readonly width: number;
  /** The first level of the island; equals `levels` when there is none. */
  readonly islandFrom: number;
}

/** One hop of an edge between adjacent levels: the unit `order` sees. */
export interface Seg {
  readonly from: string;
  readonly to: string;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const routeKey = (e: Edge): string => `${e.blockedById}>${e.issueId}`;

/**
 * Longest-path layering: an issue's level is one more than the deepest of
 * its blockers. A cycle would never settle, so the relaxation is bounded
 * and a cycle simply lands in adjacent levels. An edge that skips levels
 * takes an empty slot in each level it crosses — a waypoint, so it is
 * routed between cards and never under one — and is ordered like anything
 * else. Within a level, cards and waypoints are ordered to keep the curves
 * short and mostly uncrossed; see `order`. Issues on no edge are the
 * island: a grid under the chains, a few wide.
 */
export function layout(graph: Graph): Layout {
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const e of graph.edges) {
    push(blockers, e.issueId, e.blockedById);
    push(dependents, e.blockedById, e.issueId);
  }
  const ids = graph.issues.map((i) => i.id);
  const level = new Map<string, number>(ids.map((id) => [id, 0]));
  const passes = Math.min(ids.length, 64);
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const id of ids) {
      const want = Math.max(
        0,
        ...(blockers.get(id) ?? []).map((b) => (level.get(b) ?? 0) + 1),
      );
      if (want > (level.get(id) ?? 0)) {
        level.set(id, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const onEdge = new Set<string>([...blockers.keys(), ...dependents.keys()]);
  const chained = graph.issues.filter((i) => onEdge.has(i.id));
  const island = graph.issues.filter((i) => !onEdge.has(i.id));
  const depth =
    chained.length === 0
      ? 0
      : Math.max(...chained.map((i) => level.get(i.id) ?? 0)) + 1;
  const rows: string[][] = Array.from({ length: depth }, () => []);
  const tie = new Map<string, number>();
  for (const i of chained) {
    rows[level.get(i.id) ?? 0]!.push(i.id);
    tie.set(i.id, i.number);
  }
  // Split every edge into hops between adjacent levels; the joints are the
  // waypoints, which take a slot each so the line has somewhere to go.
  const segs: Seg[] = [];
  const waypoints = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = level.get(e.blockedById);
    const to = level.get(e.issueId);
    if (from === undefined || to === undefined) continue;
    if (to - from <= 1) {
      segs.push({ from: e.blockedById, to: e.issueId });
      continue;
    }
    let prev = e.blockedById;
    const via: string[] = [];
    for (let l = from + 1; l < to; l++) {
      const d = `${routeKey(e)}@${l}`;
      rows[l]!.push(d);
      level.set(d, l);
      tie.set(d, Number.MAX_SAFE_INTEGER);
      segs.push({ from: prev, to: d });
      via.push(d);
      prev = d;
    }
    segs.push({ from: prev, to: e.issueId });
    waypoints.set(routeKey(e), via);
  }
  order(rows, segs, level, tie);
  // Cards take the slots, in the order found. A waypoint takes no room of
  // its own: its line runs straight between the edge's two cards, down the
  // gutter nearest that line at each level, sharing the gutter if it must.
  const slot = new Map<string, number>();
  for (const row of rows) {
    let cards = 0;
    for (const id of row)
      if (tie.get(id) !== Number.MAX_SAFE_INTEGER) slot.set(id, cards++);
  }
  const via = new Map<string, Via>();
  const sharing = new Map<string, { id: string; at: number }[]>();
  for (const e of graph.edges) {
    const ids = waypoints.get(routeKey(e));
    if (ids === undefined) continue;
    const at = (slot.get(e.blockedById)! + slot.get(e.issueId)!) / 2;
    // Gutter g sits half a slot (and half a gap) left of slot g.
    const gutter = Math.max(0, Math.round(at + 0.5 + GUTTER_LEAN));
    for (const d of ids)
      push(sharing, `${level.get(d)}:${gutter}`, { id: d, at });
  }
  for (const [key, list] of sharing) {
    list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const [l, g] = key.split(":").map(Number) as [number, number];
    list.forEach(({ id }, lane) =>
      via.set(id, { level: l, gutter: g, lane, lanes: list.length }),
    );
  }
  const width = Math.max(0, ...[...slot.values()].map((s) => s + 1));
  const cols = Math.min(6, Math.max(3, width));
  const nodes: Placed[] = [
    ...chained.map((issue) => ({
      issue,
      level: level.get(issue.id) ?? 0,
      slot: slot.get(issue.id) ?? 0,
      island: false,
    })),
    ...island.map((issue, n) => ({
      issue,
      level: depth + Math.floor(n / cols),
      slot: n % cols,
      island: true,
    })),
  ];
  const routes: Route[] = graph.edges
    .filter((e) => waypoints.has(routeKey(e)))
    .map((e) => ({
      issueId: e.issueId,
      blockedById: e.blockedById,
      via: (waypoints.get(routeKey(e)) ?? [])
        .map((d) => via.get(d))
        .filter((v): v is Via => v !== undefined),
    }));
  return {
    nodes,
    routes,
    levels: depth + Math.ceil(island.length / cols),
    width: Math.max(width, Math.min(cols, island.length)),
    islandFrom: depth,
  };
}

/**
 * Whether two hops cross, drawn as monotone curves between their ends:
 * their spans of levels overlap and their ends are in opposite order.
 * Hops that share an end never cross; they meet.
 */
function cross(
  s: Seg,
  t: Seg,
  level: Map<string, number>,
  pos: Map<string, number>,
): boolean {
  if (s.from === t.from || s.to === t.to || s.from === t.to || s.to === t.from)
    return false;
  const sa = level.get(s.from)!;
  const sb = level.get(s.to)!;
  const ta = level.get(t.from)!;
  const tb = level.get(t.to)!;
  if (
    Math.max(Math.min(sa, sb), Math.min(ta, tb)) >=
    Math.min(Math.max(sa, sb), Math.max(ta, tb))
  )
    return false;
  const top = pos.get(s.from)! - pos.get(t.from)!;
  const bottom = pos.get(s.to)! - pos.get(t.to)!;
  return top * bottom < 0;
}

/**
 * The same count as comparing every pair of hops with `cross`, without
 * doing so (#3693: 2,266 edges drew 30 s of layout). A hop down one level crosses
 * another in the same gap exactly when their ends are in opposite order,
 * so each gap is an inversion count over a Fenwick tree, O(k log k). Hops
 * that point up or skip levels (only a cycle draws them) keep the pairwise
 * test against every hop; hops within one level never cross anything.
 */
export function countCrossings(
  segs: readonly Seg[],
  level: Map<string, number>,
  pos: Map<string, number>,
): number {
  const gaps = new Map<number, [number, number][]>();
  const odd: Seg[] = [];
  const spanning: Seg[] = [];
  for (const s of segs) {
    const a = level.get(s.from)!;
    const b = level.get(s.to)!;
    if (a === b) continue;
    spanning.push(s);
    if (b === a + 1) push(gaps, a, [pos.get(s.from)!, pos.get(s.to)!]);
    else odd.push(s);
  }
  let n = 0;
  for (const hops of gaps.values()) {
    // Top end ascending, bottom ascending on ties: an equal top or an equal
    // bottom is a shared card, which meets rather than crosses.
    hops.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const size = hops.reduce((most, h) => Math.max(most, h[1]), 0) + 2;
    const tree = new Int32Array(size + 1);
    let seen = 0;
    for (const [, bottom] of hops) {
      // Hops already seen with a bottom strictly right of this one's.
      let atMost = 0;
      for (let i = bottom + 1; i > 0; i -= i & -i) atMost += tree[i]!;
      n += seen - atMost;
      for (let i = bottom + 1; i <= size; i += i & -i) tree[i]!++;
      seen++;
    }
  }
  // An odd hop against every hop, each pair of odd hops once.
  const oddAt = new Map(odd.map((s, i) => [s, i]));
  odd.forEach((s, i) => {
    for (const t of spanning) {
      const j = oddAt.get(t);
      if ((j === undefined || j > i) && cross(s, t, level, pos)) n++;
    }
  });
  return n;
}

/**
 * How many crossings a layout draws between its edges, card to card; what
 * `order` minimises, counted the way a reader sees it.
 */
export function crossings(graph: Graph, placed: Layout): number {
  const level = new Map(placed.nodes.map((n) => [n.issue.id, n.level]));
  const pos = new Map(placed.nodes.map((n) => [n.issue.id, n.slot]));
  const segs = graph.edges
    .filter((e) => level.has(e.issueId) && level.has(e.blockedById))
    .map((e) => ({ from: e.blockedById, to: e.issueId }));
  return countCrossings(segs, level, pos);
}

/**
 * Ordering within levels. Barycenter sweeps first: each level is sorted by
 * the mean position of what it hangs from (down the levels), then of what
 * hangs from it (back up), a few times, keeping the best ordering seen.
 * Then a transposition pass: neighbours swap wherever that draws fewer
 * crossings between the hops they touch. Pure, and deterministic — ties
 * fall back to the issue number, waypoints after cards.
 */
function order(
  rows: string[][],
  segs: readonly Seg[],
  level: Map<string, number>,
  tie: Map<string, number>,
): Map<string, number> {
  const pos = new Map<string, number>();
  for (const row of rows) row.forEach((id, n) => pos.set(id, n));
  if (rows.length < 2) return pos;
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const s of segs) {
    push(up, s.to, s.from);
    push(down, s.from, s.to);
  }
  const sortRow = (row: string[], near: Map<string, string[]>): void => {
    const keyed = row.map((id) => {
      const ids = near.get(id) ?? [];
      const k =
        ids.length === 0
          ? pos.get(id)!
          : ids.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / ids.length;
      return { id, k };
    });
    keyed.sort((a, b) => a.k - b.k || tie.get(a.id)! - tie.get(b.id)!);
    keyed.forEach((k, n) => {
      row[n] = k.id;
      pos.set(k.id, n);
    });
  };
  let best = countCrossings(segs, level, pos);
  let bestPos = new Map(pos);
  for (let sweep = 0; sweep < 4 && best > 0; sweep++) {
    for (let l = 1; l < rows.length; l++) sortRow(rows[l]!, up);
    for (let l = rows.length - 2; l >= 0; l--) sortRow(rows[l]!, down);
    const n = countCrossings(segs, level, pos);
    if (n < best) {
      best = n;
      bestPos = new Map(pos);
    }
  }
  for (const [id, n] of bestPos) pos.set(id, n);
  for (const row of rows) row.sort((a, b) => pos.get(a)! - pos.get(b)!);

  const touching = new Map<string, Seg[]>();
  for (const s of segs) {
    push(touching, s.to, s);
    push(touching, s.from, s);
  }
  const between = (a: string, b: string): number => {
    let n = 0;
    for (const s of touching.get(a) ?? [])
      for (const t of touching.get(b) ?? []) if (cross(s, t, level, pos)) n++;
    return n;
  };
  for (let round = 0; round < 4 && best > 0; round++) {
    let improved = false;
    for (const row of rows)
      for (let i = 0; i + 1 < row.length; i++) {
        const a = row[i]!;
        const b = row[i + 1]!;
        const before = between(a, b);
        if (before === 0) continue;
        pos.set(a, i + 1);
        pos.set(b, i);
        if (between(a, b) < before) {
          row[i] = b;
          row[i + 1] = a;
          improved = true;
        } else {
          pos.set(a, i);
          pos.set(b, i + 1);
        }
      }
    if (!improved) break;
  }
  return pos;
}

// ---- the words ----

/** The one word a card says. */
export type Word =
  | "ready"
  | "working"
  | "blocked"
  | "deferred"
  | "done"
  | "parked"
  | "waiting"
  | "held";

const WORDS: readonly Word[] = [
  "ready",
  "working",
  "blocked",
  "waiting",
  "held",
  "parked",
  "deferred",
  "done",
];

/** What is known about a repository's issues beyond the graph itself. */
export interface Marks {
  /** Issues the crew is on right now, by issue id; see `crewMarks`. */
  readonly crew: Map<string, RunState>;
  /** Open issues an open pull would close: proposed, not landed. */
  readonly waiting: Set<string>;
  /** Of those, the ones whose pull a person holds, by issue id: "alice: second review under way". */
  readonly onHold: Map<string, string>;
  /** Issues whose last word is the crew parking them, or whose blocker closed unfinished. */
  readonly parked: Set<string>;
  /** Why an issue is parked on a closed blocker, by issue id: "#4 was dropped". */
  readonly why: Map<string, string>;
  /**
   * Work that is deferred, by issue id, with why: "behind the Later gate",
   * or "only deferred work needs it: #12 One interface" (`core/dependencies.ts`).
   */
  readonly deferred: ReadonlyMap<string, string>;
  /** The issues the crew parked twice: the planner's now, with every reason. */
  readonly twice: readonly ParkedTwice[];
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

/** The marks for one repository's graph: three reads, all bounded. */
export function marksFor(
  db: Database,
  repoId: string,
  graph: Graph,
  runs: readonly Run[],
): Marks {
  const repo = getRepoById(db, repoId);
  if (repo === undefined) return NO_MARKS;
  const byNumber = new Map(graph.issues.map((i) => [i.number, i.id]));
  const waiting = new Set<string>();
  const onHold = new Map<string, string>();
  const closing = proposedWork(db, repo);
  const holds = holdsFor(
    db,
    [...closing.values()].map((pull) => pull.id),
  );
  for (const [number, pull] of closing) {
    const id = byNumber.get(number);
    if (id === undefined) continue;
    waiting.add(id);
    const hold = holds.get(pull.id);
    if (hold !== undefined) onHold.set(id, `${hold.heldByName}: ${hold.why}`);
  }
  const open = graph.issues.filter((i) => i.state === "open").map((i) => i.id);
  const parked = struckOut(db, repo, open);
  const why = new Map<string, string>();
  const numbers = new Map(graph.issues.map((i) => [i.id, i.number]));
  for (const id of graph.unadopted) {
    parked.add(id);
    why.set(id, READER_SUGGESTION);
  }
  // An umbrella or the gate with nothing open in front of it is not ready:
  // it is a person's to close.
  for (const issue of idleFurniture(graph)) {
    parked.add(issue.id);
    why.set(issue.id, PLAN_OWN);
  }
  for (const h of graph.held) {
    parked.add(h.issueId);
    const note = `#${numbers.get(h.blockedById)} was ${h.reason === "split" ? "split" : "dropped"}`;
    const had = why.get(h.issueId);
    why.set(h.issueId, had === undefined ? note : `${had}; ${note}`);
  }
  // The plan's own furniture is not work that was deferred: it keeps its word.
  const deferred = new Map(
    [...graph.deferred].filter(([id]) => !graph.structural.has(id)),
  );
  return {
    crew: crewMarks(runs),
    waiting,
    onHold,
    parked,
    why,
    deferred,
    twice: parkedTwice(db, [repo]),
  };
}

export const NO_MARKS: Marks = {
  crew: new Map(),
  waiting: new Set(),
  onHold: new Map(),
  parked: new Set(),
  why: new Map(),
  deferred: new Map(),
  twice: [],
};

/**
 * The word for an issue, most telling first: done is done; the crew on it
 * outranks a pull for it; a pull a person holds says so rather than that it
 * waits; a pull outranks having been parked; and what is left is ready or
 * blocked by what the graph says.
 */
export function wordFor(issue: Issue, ready: Set<string>, marks: Marks): Word {
  if (issue.state === "closed") return "done";
  if (marks.crew.has(issue.id)) return "working";
  if (marks.onHold.has(issue.id)) return "held";
  if (marks.waiting.has(issue.id)) return "waiting";
  if (marks.parked.has(issue.id)) return "parked";
  if (marks.deferred.has(issue.id)) return "deferred";
  return ready.has(issue.id) ? "ready" : "blocked";
}

// ---- drawing ----

const W = 196;
const H = 68;
const GX = 28;
const GY = 44;
const PAD = 22;
/** Between lines that share a gutter. */
const LANE = 6;
/** How far left of a slot's centre its left gutter lies, in slots. */
const GUTTER_LEAN = GX / 2 / (W + GX);
/** Room for the rule between the chains and the island. */
const RULE = 30;
/** Characters of title per line at the card's type size, conservatively. */
const LINE = 26;

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A title on at most two lines, whole words where they fit, then an ellipsis. */
export function wrapTitle(title: string, max = LINE): [string, string | null] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ["", null];
  let first = "";
  let at = 0;
  for (; at < words.length; at++) {
    const next = first === "" ? words[at]! : `${first} ${words[at]}`;
    if (next.length > max) break;
    first = next;
  }
  if (first === "")
    return [trim(words[0]!, max), trim(words.slice(1).join(" "), max) || null];
  const rest = words.slice(at).join(" ");
  return [first, rest === "" ? null : trim(rest, max)];
}

export interface Emphasis {
  readonly ready: Set<string>;
  /** The issues on the critical path. */
  readonly critical: Set<string>;
  /** The path's own edges, blocker to blocked, as `routeKey`s. */
  readonly chain: Set<string>;
  readonly marks: Marks;
}

/** What to emphasise, from the ready list, the critical path and the marks. */
export function emphasisFor(
  ready: readonly Ranked[],
  path: readonly Issue[],
  marks: Marks,
): Emphasis {
  const chain = new Set<string>();
  for (let i = 0; i + 1 < path.length; i++)
    chain.add(`${path[i]!.id}>${path[i + 1]!.id}`);
  return {
    ready: new Set(ready.map((r) => r.issue.id)),
    critical: new Set(path.map((i) => i.id)),
    chain,
    marks,
  };
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly x: (slot: number) => number;
  /** Where a waypoint's line runs: in its gutter, spread if shared. */
  readonly gx: (v: Via) => number;
  readonly y: (level: number) => number;
  /** Whether a rule separates the chains from the island. */
  readonly ruled: boolean;
}

/** The drawing's own width, before any lane widens it. */
export function drawingWidth(placed: Layout): number {
  return PAD * 2 + placed.width * W + Math.max(0, placed.width - 1) * GX;
}

function geometry(placed: Layout, minWidth: number): Geometry {
  const ruled = placed.islandFrom > 0 && placed.islandFrom < placed.levels;
  const width = Math.max(minWidth, drawingWidth(placed));
  const height =
    PAD * 2 +
    placed.levels * H +
    Math.max(0, placed.levels - 1) * GY +
    (ruled ? RULE : 0);
  const x = (slot: number): number => PAD + slot * (W + GX);
  return {
    width,
    height,
    ruled,
    x,
    gx: (v) => x(v.gutter) - GX / 2 + (v.lane - (v.lanes - 1) / 2) * LANE,
    y: (level) =>
      PAD + level * (H + GY) + (ruled && level >= placed.islandFrom ? RULE : 0),
  };
}

function node(
  base: string,
  n: Placed,
  g: Geometry,
  emphasis: Emphasis,
  issueHref: (base: string, number: number) => string,
): Html {
  const word = wordFor(n.issue, emphasis.ready, emphasis.marks);
  const run = emphasis.marks.crew.get(n.issue.id);
  const [first, second] = wrapTitle(n.issue.title);
  const px = g.x(n.slot);
  const py = g.y(n.level);
  const left = px + 12;
  const bottom = py + H - 11;
  const number = `#${n.issue.number}`;
  const who = n.issue.assigneeName;
  const whoX = left + 9 + number.length * 6.4;
  return html`<a
    class="map-node"
    data-state="${word}"
    data-key="issue:${n.issue.id}"
    data-crit="${emphasis.critical.has(n.issue.id) ? "1" : "0"}"
    ${run ? html`data-run="${run}"` : null}
    href="${issueHref(base, n.issue.number)}"
    aria-label="${number} ${n.issue.title} — ${word}${word === "held" ? ` by ${emphasis.marks.onHold.get(n.issue.id)}` : word === "deferred" ? `: ${emphasis.marks.deferred.get(n.issue.id)}` : emphasis.marks.why.has(n.issue.id) ? `: ${emphasis.marks.why.get(n.issue.id)}` : ""}"
  >
    ${word === "working"
      ? html`<rect
          class="map-breath"
          x="${px - 4}"
          y="${py - 4}"
          width="${W + 8}"
          height="${H + 8}"
          rx="12"
        />`
      : null}
    <rect
      class="map-card"
      x="${px}"
      y="${py}"
      width="${W}"
      height="${H}"
      rx="8"
    />
    <text class="map-title" x="${left}" y="${py + 23}">
      ${first}${second === null
        ? null
        : html`<tspan x="${left}" dy="16">${second}</tspan>`}
    </text>
    <text class="map-meta" x="${left}" y="${bottom}">${number}</text>
    ${who
      ? html`<g class="map-who">
          <circle cx="${whoX + 7}" cy="${bottom - 4}" r="7" />
          <text class="map-who-i" x="${whoX + 7}" y="${bottom - 1}"
            >${who[0]}</text
          >
          <text class="map-who-n" x="${whoX + 19}" y="${bottom}"
            >${trim(who, 11)}</text
          >
        </g>`
      : null}
    <text class="map-word" x="${px + W - 12}" y="${bottom}" text-anchor="end">
      ${word === "done"
        ? null
        : html`<tspan class="map-dot" dy="-1">●</tspan
            ><tspan dy="1"> </tspan>`}${word}
    </text>
  </a>`;
}

/**
 * A calm curve from the bottom of one card to the top of the next, vertical
 * at both ends. An edge that skips levels runs straight through the empty
 * slots the layout kept for it, curving only between levels.
 */
function edge(
  e: Edge,
  at: Map<string, Placed>,
  via: readonly Via[],
  g: Geometry,
  emphasis: Emphasis,
): Html | null {
  const from = at.get(e.blockedById);
  const to = at.get(e.issueId);
  if (!from || !to) return null;
  let cx = g.x(from.slot) + W / 2;
  let cy = g.y(from.level) + H;
  let d = `M${cx} ${cy}`;
  const hop = (nx: number, ny: number): void => {
    const bend = Math.max(18, (ny - cy) / 2);
    d += ` C ${cx} ${cy + bend}, ${nx} ${ny - bend}, ${nx} ${ny}`;
    cx = nx;
    cy = ny;
  };
  for (const v of via) {
    const x = g.gx(v);
    hop(x, g.y(v.level));
    cy = g.y(v.level) + H;
    d += ` L ${x} ${cy}`;
  }
  hop(g.x(to.slot) + W / 2, g.y(to.level));
  const crit = emphasis.chain.has(routeKey(e));
  const faded = from.issue.state === "closed" || to.issue.state === "closed";
  return html`<path
    class="map-edge${crit ? " map-edge-crit" : ""}${faded
      ? " map-edge-done"
      : ""}"
    d="${d}"
  />`;
}

export interface DrawOptions {
  /** The container's id: the pan and zoom are remembered by it across a swap. */
  readonly id: string;
  /** Widen the drawing to this, so lanes share one scale and one grid. */
  readonly minWidth?: number;
  /** The most of the window's height the canvas takes before it pans. */
  readonly cap?: number;
  /** Where a card's own link goes. Defaults to dev's `/issues/:number`. */
  readonly issueHref?: (base: string, number: number) => string;
  /** What the empty state says, in the reader's own noun for an issue. */
  readonly empty?: MapEmpty;
}

const DEV_EMPTY: MapEmpty = {
  title: "No open issues to map",
  note: "Open one, then link what it waits for.",
};

/** What the map says when there is nothing on it: §5's empty state. */
export interface MapEmpty {
  readonly title: string;
  readonly note: string;
  readonly action?: Html;
}

export function drawMap(
  repo: Repo,
  graph: Graph,
  placed: Layout,
  emphasis: Emphasis,
  options: DrawOptions,
): Html {
  if (placed.nodes.length === 0)
    return empty({ icon: "map", ...(options.empty ?? DEV_EMPTY) });
  const base = repoBase(repo);
  const issueHref = options.issueHref ?? devIssueHref;
  const g = geometry(placed, options.minWidth ?? 0);
  const at = new Map(placed.nodes.map((n) => [n.issue.id, n]));
  const ry = g.y(placed.islandFrom) - GY / 2 - RULE / 2;
  const routed = new Map(
    placed.routes.map((r) => [`${r.blockedById}>${r.issueId}`, r.via]),
  );
  return html`<div
    class="map-canvas"
    id="${options.id}"
    data-w="${g.width}"
    data-h="${g.height}"
    data-cap="${options.cap ?? 0.72}"
    data-cuts="${Array.from({ length: placed.levels }, (_, l) =>
      l === placed.levels - 1 ? g.height : g.y(l) + H + 12,
    ).join(",")}"
  >
    <svg
      class="map-svg"
      viewBox="0 0 ${g.width} ${g.height}"
      preserveAspectRatio="xMinYMin meet"
      role="group"
      aria-label="Issues of ${repo.name} laid out by what they wait for"
    >
      ${g.ruled
        ? html`<g class="map-rule">
            <text x="${PAD}" y="${ry + 4}">not linked</text>
            <line
              x1="${PAD + 66}"
              y1="${ry}"
              x2="${g.width - PAD}"
              y2="${ry}"
            />
          </g>`
        : null}
      ${graph.edges.map((e) =>
        edge(e, at, routed.get(routeKey(e)) ?? [], g, emphasis),
      )}
      ${placed.nodes.map((n) => node(base, n, g, emphasis, issueHref))}
    </svg>
    <div class="bar js-only" role="group" aria-label="Zoom">
      <button
        type="button"
        class="btn btn-icon" data-size="sm"
        data-map="out"
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        class="btn" data-size="sm"
        data-map="fit"
        title="Fit the map to view. Drag to pan; ⌘ or Ctrl and scroll to zoom."
      >
        fit
      </button>
      <button
        type="button"
        class="btn btn-icon"
        data-size="sm"
        data-map="in"
        aria-label="Zoom in"
      >
        +
      </button>
    </div>
  </div>`;
}

/** The words, counted: the one quiet line under a drawing. */
export function countWords(words: readonly Word[]): Record<Word, number> {
  const out: Record<Word, number> = {
    ready: 0,
    working: 0,
    blocked: 0,
    done: 0,
    parked: 0,
    deferred: 0,
    waiting: 0,
    held: 0,
  };
  for (const w of words) out[w]++;
  return out;
}

export function countsLine(
  counts: Record<Word, number>,
  toggle?: { readonly base: string; readonly showDone: boolean },
): Html {
  const always = new Set<Word>(["ready", "working", "blocked", "done"]);
  const tone: Partial<Record<Word, string>> = {
    ready: "success",
    working: "attn",
    waiting: "merged",
    parked: "attn",
    held: "attn",
    done: "outline",
  };
  return html`<span data-counts>
    ${WORDS.filter((w) => always.has(w) || counts[w] > 0).map(
      (w) =>
        html`<span class="badge" data-variant="${tone[w] ?? "secondary"}" data-state="${w}">${w} <b>${counts[w]}</b></span> `,
    )}
    ${toggle === undefined || counts.done === 0
      ? null
      : html`<a
          class="map-toggle"
          href="${toggle.showDone ? toggle.base : `${toggle.base}?done=1`}"
          >${toggle.showDone ? "Open only" : "Show done"}</a
        >`}
  </span>`;
}

function rankedList(
  repo: Repo,
  title: string,
  items: Ranked[],
  say: (r: Ranked) => string,
  empty: string,
  issueHref: (base: string, number: number) => string,
  first?: { writer: boolean; by: ReadonlyMap<string, string> },
): Html {
  const base = repoBase(repo);
  return html`<section class="stack-tight">
    <h2>${title}</h2>
    ${items.length === 0
      ? html`<p class="muted small">${empty}</p>`
      : html`<ul class="list setting-list">
            ${items.slice(0, 6).map((r) =>
              row({
                href: issueHref(base, r.issue.number),
                title: r.issue.title,
                titleAttr: r.issue.title,
                meta: html`#${r.issue.number} · ${say(r)}${first?.by.has(r.issue.id)
                  ? ` · first, by ${first.by.get(r.issue.id)}`
                  : ""}`,
                ...(first?.writer
                  ? {
                      trail: html`<form
                        method="post"
                        action="${base}/issues/${r.issue.number}/first"
                      >
                        <input type="hidden" name="back" value="${base}/map" />
                        ${btn("First", { variant: "outline", size: "sm" })}
                      </form>`,
                    }
                  : {}),
              }),
            )}
          </ul>`}
  </section>`;
}

/** One pillar's open work on the map: how much, and how much of it can move. */
export interface PillarRow {
  /** The pillar's name; null is the work that names none. */
  readonly name: string | null;
  /** The umbrella's number, for a pillar. */
  readonly umbrella?: number;
  readonly open: number;
  readonly ready: number;
  readonly blocked: number;
  /** For a pillar: the week's merged pulls, and how long asking took. */
  readonly merged?: number;
  readonly askToLive?: AskToLive | undefined;
  /** For no pillar: the issues themselves, to be filed. */
  readonly issues?: readonly Issue[];
}

/**
 * The open issues counted by pillar: every pillar in order, then the work
 * that names none, when there is any. The plan's own furniture — the
 * umbrellas, the gate, the direction — is not work and is not counted.
 */
export function pillarRows(
  repo: Repo,
  graph: Graph,
  ready: Set<string>,
  marks: Marks,
  view: PillarView,
  ask: readonly AskToLiveCount[] = [],
): PillarRow[] {
  const tally = new Map<
    string | null,
    { open: number; ready: number; blocked: number }
  >(view.names.map((name) => [name, { open: 0, ready: 0, blocked: 0 }]));
  const umbrella = new Map<string, number>(
    view.set.pillars.map((p) => [p.name, p.umbrella.number]),
  );
  if (view.set.later !== undefined) umbrella.set(LATER, view.set.later.number);
  const loose: Issue[] = [];
  for (const issue of graph.issues) {
    if (issue.state !== "open" || isStructural(view.set, issue.id)) continue;
    if (issue.id === repo.directionIssueId) continue;
    const name = view.of.get(issue.id) ?? null;
    const row = tally.get(name) ?? { open: 0, ready: 0, blocked: 0 };
    const word = wordFor(issue, ready, marks);
    row.open++;
    if (word === "ready") row.ready++;
    if (word === "blocked") row.blocked++;
    tally.set(name, row);
    if (name === null) loose.push(issue);
  }
  return [
    ...view.names.map((name) => ({
      name,
      ...(umbrella.has(name) ? { umbrella: umbrella.get(name)! } : {}),
      ...tally.get(name)!,
      merged: view.merged.find((m) => m.pillar === name)?.merged ?? 0,
      askToLive: ask.find((a) => a.pillar === name)?.askToLive,
    })),
    ...(loose.length === 0
      ? []
      : [{ name: null, ...tally.get(null)!, issues: loose }]),
  ];
}

/** Hours as a person reads them: `3.5h`, or `2.1d` past two days. */
export function hours(h: number): string {
  return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h}h`;
}

/** Where a pillar's issues are: the list, narrowed to its label. */
export const pillarHref = (base: string, name: string): string =>
  `${base}/issues?label=${encodeURIComponent(name)}`;

/**
 * The map by pillar: is the crew building what was asked. One row a
 * pillar — a link to its milestone, where its issues and how far they are
 * can be read — with what is open, ready and blocked; then the issues that
 * name no pillar, each a link, since they are the ones to file.
 */
function pillarList(repo: Repo, rows: readonly PillarRow[]): Html {
  const base = repoBase(repo);
  const counts = (r: PillarRow): string =>
    r.open === 0
      ? "nothing open"
      : `${r.open} open · ${r.ready} ready · ${r.blocked} blocked`;
  return html`<section class="stack-tight" id="map-pillars">
    <h2>By pillar</h2>
    ${html`<ul class="list setting-list">
        ${rows.map((r) =>
          r.name === null
            ? row({
                title: NO_PILLAR,
                meta: html`${(r.issues ?? []).slice(0, 8).map(
                  (i) =>
                    html`<a href="${base}/issues/${i.number}" title="${i.title}"
                        >#${i.number}</a
                      >${" "}`,
                )}${(r.issues ?? []).length > 8 ? "…" : ""}`,
                trail: html`<span class="muted small">${counts(r)}</span>`,
                data: { pillar: "" },
              })
            : row({
                title: html`<a
                  class="break"
                  href="${r.umbrella === undefined
                    ? pillarHref(base, r.name)
                    : milestoneHref(base, r.umbrella)}"
                  >${r.name}</a
                >`,
                meta: html`<span class="map-ask" title="Median and slowest hours from an issue opening to its change live in production, over ${PILLAR_DAYS} days"
                  >${r.merged ?? 0} merged · ask to live
                  ${r.askToLive === undefined
                    ? "—"
                    : html`${hours(r.askToLive.medianHours)} median, slowest
                        <a href="${base}/issues/${r.askToLive.slowest.number}"
                          >#${r.askToLive.slowest.number}</a
                        >
                        ${hours(r.askToLive.slowest.hours)}`}</span
                >`,
                trail: html`<span class="muted small">${counts(r)}</span>`,
                data: { pillar: r.name },
              }),
        )}
      </ul>`}
  </section>`;
}

export const mapCss = /* css */ `
.map-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 272px; gap: 24px; align-items: start; margin-top: 4px; }
@media (max-width: 860px) { .map-wrap { grid-template-columns: 1fr; } }
.map-main { min-width: 0; }

/* ---- the canvas ---- */
.map-canvas { position: relative; overflow: hidden; border: 0; border-radius: 0; background: var(--bg); touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.map-canvas.is-view { cursor: grab; }
.map-canvas.is-drag { cursor: grabbing; }
.map-canvas.is-cut::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 36px; background: linear-gradient(to bottom, transparent, var(--bg)); pointer-events: none; }
.map-svg { display: block; width: 100%; height: auto; }
.map-canvas.is-view .map-svg { height: 100%; }
.map-svg text { font-family: var(--font); pointer-events: none; }
.map-canvas > [role="group"] { position: absolute; top: 8px; right: 8px; gap: 4px; }

/* ---- cards ---- */
.map-node { cursor: pointer; outline: none; }
.map-card { fill: var(--card); stroke: var(--border); stroke-width: 1; transition: stroke 120ms var(--ease), fill 120ms var(--ease); }
.map-node[data-state="ready"] .map-card { stroke: var(--border-strong); }
.map-node[data-state="working"] .map-card { stroke: var(--accent); }
.map-node[data-state="blocked"] .map-card { fill: var(--muted); }
.map-node[data-state="waiting"] .map-card { stroke: color-mix(in srgb, var(--merged) 55%, var(--border)); }
.map-node[data-state="parked"] .map-card { fill: color-mix(in srgb, var(--attn) 7%, var(--card)); stroke: color-mix(in srgb, var(--attn) 45%, var(--border)); }
.map-node[data-state="done"] .map-card { fill: none; stroke: var(--border); }
.map-node:hover .map-card { stroke: var(--border-strong); }
.map-node[data-state="working"]:hover .map-card { stroke: var(--accent); }
.map-node:focus-visible .map-card { stroke: var(--accent); stroke-width: 2; }
/* A soft outer ring, static: any animation inside a large inline SVG
   repaints the whole drawing every frame, whatever property it touches. */
.map-breath { fill: none; stroke: var(--accent); stroke-width: 1.5; opacity: .35; }
.map-title { font-size: 12.5px; font-weight: 560; fill: var(--fg); transition: fill 120ms var(--ease); }
.map-node:hover .map-title { fill: var(--accent); }
.map-node[data-state="done"] .map-title, .map-node[data-state="done"] .map-meta, .map-node[data-state="done"] .map-word { fill: var(--faint); }
.map-node[data-state="deferred"] .map-card { fill: none; stroke-dasharray: 4 3; }
.map-node[data-state="deferred"] .map-title { fill: var(--muted-fg); }
.map-node[data-state="blocked"] .map-title { fill: var(--muted-fg); }
.map-meta { font-size: var(--fs-min); fill: var(--faint); font-variant-numeric: tabular-nums; }
.map-who circle { fill: var(--muted); stroke: var(--border); }
.map-who-i { font-size: var(--fs-min); font-weight: 650; text-transform: uppercase; fill: var(--fg); }
.map-who-n { font-size: var(--fs-min); fill: var(--muted-fg); }
.map-word { font-size: var(--fs-min); font-weight: 550; fill: var(--muted-fg); }
.map-word .map-dot { font-size: var(--fs-min); fill: var(--faint); }
.map-node[data-state="ready"] .map-dot { fill: var(--success); }
.map-node[data-state="working"] .map-dot { fill: var(--accent); }
.map-node[data-state="working"] .map-word { fill: var(--accent); }
.map-node[data-state="waiting"] .map-dot { fill: var(--merged); }
.map-node[data-state="parked"] .map-dot { fill: var(--attn); }
.map-node[data-state="parked"] .map-word { fill: var(--attn); }
.map-node[data-state="held"] .map-card { stroke: color-mix(in srgb, var(--attn) 45%, var(--border)); }
.map-node[data-state="held"] .map-dot { fill: var(--attn); }
.map-node[data-state="held"] .map-word { fill: var(--attn); }

/* ---- edges ---- */
.map-edge { fill: none; stroke: var(--border-strong); stroke-width: 1.25; }
.map-edge-crit { stroke: var(--accent); }
.map-edge-done { opacity: .45; }
.map-rule line { stroke: var(--border); stroke-width: 1; }
.map-rule text { font-size: var(--fs-min); fill: var(--faint); letter-spacing: .02em; }

/* ---- beside the drawing ---- */
.map-ask { display: inline; }
.map-toggle { display: inline-block; padding: 2px 8px; font-size: 12.5px; }
@media (pointer: coarse) { .map-toggle { display: inline-flex; align-items: center; min-height: 44px; padding: 0 12px; } }

/* ---- lanes: §5 list rows that fold ---- */
#lanes { margin-top: 16px; }
#lanes li[data-autonomy="autonomous"] .row-title .badge { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 34%, transparent); }
#lanes li[data-idle] .row-title { color: var(--muted-fg); }
#lanes details > .empty { border-top: 1px solid var(--border); }
#lanes details > .map-canvas { border: 0; border-top: 1px solid var(--border); border-radius: 0; }
@media (prefers-reduced-motion: reduce) {
  .map-card, .map-title { transition: none; }
}
@media (forced-colors: active) {
  .map-node:focus-visible .map-card { stroke: Highlight; stroke-width: 3; }
}
`;

/**
 * Fit, pan and zoom, and folds that survive a live swap. The drawing is a
 * viewBox: fitting is choosing one, panning moves its origin, zooming
 * shrinks it around a point — no transforms, and text stays crisp. Each
 * canvas remembers its view by id, so when a live region swaps the SVG
 * under the reader, they are still looking where they were looking.
 * Scroll zooms only with ⌘ or Ctrl (a trackpad pinch sends exactly that),
 * because a page of lanes must still scroll like a page.
 */
export const mapViewJs = /* js */ `
(function () {
  var MIN = 0.35, MAX = 2.5;
  var views = {};
  var folds = {};
  function all(root) { return Array.prototype.slice.call((root || document).querySelectorAll('.map-canvas')); }
  function apply(canvas) {
    var svg = canvas.querySelector('.map-svg'), v = views[canvas.id];
    if (!svg || !v) return;
    svg.setAttribute('viewBox', v.x.toFixed(2) + ' ' + v.y.toFixed(2) + ' ' + (v.cw / v.k).toFixed(2) + ' ' + (v.ch / v.k).toFixed(2));
  }
  function setup(canvas, refit) {
    if (!canvas.id || !canvas.querySelector('.map-svg') || !canvas.clientWidth) return;
    var W = +canvas.getAttribute('data-w') || 1, H = +canvas.getAttribute('data-h') || 1;
    var cw = canvas.clientWidth;
    var fitK = Math.min(1, Math.max(0.5, cw / W));
    var cap = +canvas.getAttribute('data-cap') || 0.72;
    // Tall drawings are cut to the window's share, at a level's foot, never
    // through a card; a fade says there is more.
    var most = Math.round(window.innerHeight * cap), full = Math.round(H * fitK) + 2, ch = full;
    if (full > most) {
      ch = most;
      (canvas.getAttribute('data-cuts') || '').split(',').forEach(function (c) {
        var y = Math.round(+c * fitK) + 2;
        if (y <= most && y >= 120) ch = y;
      });
    }
    ch = Math.max(120, ch);
    canvas.classList.toggle('is-cut', full > ch);
    canvas.classList.add('is-view');
    canvas.style.height = ch + 'px';
    var v = views[canvas.id];
    if (!v || refit || !v.touched) v = views[canvas.id] = { k: fitK, x: 0, y: 0, touched: false };
    v.cw = cw; v.ch = ch;
    apply(canvas);
  }
  function zoom(canvas, factor, cx, cy) {
    var v = views[canvas.id]; if (!v) return;
    var k = Math.min(MAX, Math.max(MIN, v.k * factor));
    if (k === v.k) return;
    if (cx === undefined) { cx = v.cw / 2; cy = v.ch / 2; }
    v.x += cx / v.k - cx / k; v.y += cy / v.k - cy / k; v.k = k; v.touched = true;
    apply(canvas);
  }
  function pan(canvas, dx, dy) {
    var v = views[canvas.id]; if (!v) return;
    v.x -= dx / v.k; v.y -= dy / v.k; v.touched = true;
    apply(canvas);
  }
  function canvasOf(e) { return e.target && e.target.closest ? e.target.closest('.map-canvas') : null; }
  function at(canvas, e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  var pointers = {}, drag = null;
  document.addEventListener('pointerdown', function (e) {
    var canvas = canvasOf(e);
    if (!canvas || !views[canvas.id] || e.target.closest('[role="group"]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    if (ids.length === 1) drag = { canvas: canvas, x: e.clientX, y: e.clientY, moved: false, pinch: null };
    else if (ids.length === 2 && drag) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      drag.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag || !(e.pointerId in pointers)) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    if (ids.length >= 2 && drag.pinch) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var r = drag.canvas.getBoundingClientRect();
      if (drag.pinch.d > 0) zoom(drag.canvas, d / drag.pinch.d, mx - r.left, my - r.top);
      pan(drag.canvas, mx - drag.pinch.mx, my - drag.pinch.my);
      drag.pinch = { d: d, mx: mx, my: my }; drag.moved = true;
      e.preventDefault();
      return;
    }
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true; drag.canvas.classList.add('is-drag');
    pan(drag.canvas, dx, dy); drag.x = e.clientX; drag.y = e.clientY;
    e.preventDefault();
  }, { passive: false });
  function release(e) {
    delete pointers[e.pointerId];
    if (!drag) return;
    if (Object.keys(pointers).length > 0) { drag.pinch = null; return; }
    var c = drag.canvas, moved = drag.moved;
    c.classList.remove('is-drag');
    drag = null;
    if (moved) { c.setAttribute('data-dragged', '1'); setTimeout(function () { c.removeAttribute('data-dragged'); }, 0); }
  }
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('click', function (e) {
    var canvas = canvasOf(e);
    if (!canvas) return;
    if (canvas.hasAttribute('data-dragged')) { e.preventDefault(); e.stopPropagation(); return; }
    var tool = e.target.closest('[data-map]');
    if (!tool) return;
    var what = tool.getAttribute('data-map');
    if (what === 'fit') setup(canvas, true); else zoom(canvas, what === 'in' ? 1.25 : 0.8);
  }, true);
  document.addEventListener('wheel', function (e) {
    var canvas = canvasOf(e);
    if (!canvas || !views[canvas.id] || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    var p = at(canvas, e);
    zoom(canvas, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), p[0], p[1]);
  }, { passive: false });
  document.addEventListener('dblclick', function (e) {
    var canvas = canvasOf(e);
    if (!canvas || !views[canvas.id] || e.target.closest('[role="group"]')) return;
    e.preventDefault();
    var p = at(canvas, e);
    zoom(canvas, 1.6, p[0], p[1]);
  });
  document.addEventListener('focusin', function (e) {
    var node = e.target && e.target.closest ? e.target.closest('.map-node') : null;
    if (!node) return;
    var canvas = node.closest('.map-canvas');
    if (!canvas || !views[canvas.id]) return;
    var r = node.getBoundingClientRect(), c = canvas.getBoundingClientRect(), m = 12, dx = 0, dy = 0;
    if (r.left < c.left + m) dx = c.left + m - r.left; else if (r.right > c.right - m) dx = c.right - m - r.right;
    if (r.top < c.top + m) dy = c.top + m - r.top; else if (r.bottom > c.bottom - m) dy = c.bottom - m - r.bottom;
    if (dx || dy) pan(canvas, dx, dy);
  });

  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.id || d.id.indexOf('lane-') !== 0) return;
    folds[d.id] = d.open;
    if (d.open) all(d).forEach(function (c) { setup(c, false); });
  }, true);
  function restore(root) {
    Array.prototype.forEach.call(root.querySelectorAll('details[id^="lane-"]'), function (d) { if (d.id in folds) d.open = folds[d.id]; });
    if (root.classList && root.classList.contains('map-canvas')) setup(root, false);
    all(root).forEach(function (c) { setup(c, false); });
  }
  document.addEventListener('forge:swapped', function (e) { if (e.target && e.target.querySelectorAll) restore(e.target); });
  window.addEventListener('resize', function () { all().forEach(function (c) { setup(c, false); }); });
  all().forEach(function (c) { setup(c, false); });
})();
`;

export const LIVE_KINDS = "run.queued,run.started,run.finished,issue.*,pull.*";

/** The empty state in the studio's own words, pointing at the app page's
 * own box for telling the crew (`#tell`, `src/web/studio/app.ts`). */
const studioEmpty = (base: string): MapEmpty => ({
  title: "No issues to map yet",
  note: "Say one, then link what it waits for.",
  action: btn("Say one", { href: `${base}#tell`, variant: "primary" }),
});

/**
 * The graph as the page draws it by default: open issues and the edges
 * between them. Readiness is judged on the whole graph, not on this.
 */
function openOnly(graph: Graph): Graph {
  const issues = graph.issues.filter((i) => i.state === "open");
  const kept = new Set(issues.map((i) => i.id));
  return {
    ...graph,
    issues,
    edges: graph.edges.filter(
      (e) => kept.has(e.blockedById) && kept.has(e.issueId),
    ),
  };
}

/** GET /:owner/:name/map (`?done=1` draws the closed issues too) */
export async function mapPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const db = ctx.app.db;
  const studio = studioRecord(ctx, repo) !== undefined;
  const showDone = ctx.url.searchParams.get("done") === "1";
  // The read, one Server-Timing phase per step (#8381); `render` is the page's own.
  const rq = ctx.request;
  const reading = performance.now();
  const graph = timePhase(rq, "map-graph", () =>
    repoGraph(db, repo.id, { ...sealedScope(db, repo, ctx.auth.user), lean: true }),
  );
  const ready = timePhase(rq, "map-ready", () => readyNow(graph));
  const blocked = timePhase(rq, "map-blocked", () => blockedOn(graph));
  const critical = timePhase(rq, "map-critical", () => criticalPath(graph));
  const shown = timePhase(rq, "map-shown", () => (showDone ? graph : openOnly(graph)));
  const placed = timePhase(rq, "map-layout", () => cachedLayout(shown, layout));
  const marks = timePhase(rq, "map-marks", () =>
    marksFor(db, repo.id, graph, listActiveRuns(db, [repo.id])),
  );
  const { readySet, counts } = timePhase(rq, "map-words", () => {
    const readySet = new Set(ready.map((r) => r.issue.id));
    return { readySet, counts: countWords(graph.issues.map((i) => wordFor(i, readySet, marks))) };
  });
  const pillars = timePhase(rq, "map-pillars", () => pillarView(db, repo));
  const ask = timePhase(rq, "map-ask", () =>
    askToLiveFor(ctx.app, repo, pillars, ctx.auth.user),
  );
  // The ten named steps above replace the old single `map` phase; `map` is
  // still noted, by hand, as their total, for readers of the header.
  notePhase(rq, "map", performance.now() - reading);
  const rendering = performance.now();
  /** A row's pillar, as the words lead with it: "Name · ", or nothing. */
  const pillarOf = (r: Ranked): string => {
    const name = pillars?.of.get(r.issue.id);
    return name === undefined || name === null ? "" : `${name} · `;
  };
  const body = html`${repoHeader(ctx, repo, "map")}
    <div class="page-head mt">
      <h1>Map</h1>
      <p class="muted">
        What waits for what. The top edge is ready now; the chain in the accent
        is the least work that still has to happen in order.
        <a href="${repoBase(repo)}/milestones">How far each milestone is</a>.
        <a href="${repoBase(repo)}/next">Next up</a> is the one ranked list the crew builds from.
      </p>
    </div>
    <div
      class="map-wrap"
      id="map-live"
      data-live="${LIVE_KINDS}"
      data-live-repo="${repo.ownerName}/${repo.name}"
    >
      <div class="map-main">
        ${drawMap(repo, shown, placed, emphasisFor(ready, critical, marks), {
          id: "map-canvas",
          cap: 1,
          issueHref: tellHref,
          ...(studio ? { empty: studioEmpty(repoBase(repo)) } : {}),
        })}
        ${placed.nodes.length === 0 && counts.done === 0 ? null : countsLine(counts, { base: `${repoBase(repo)}/map`, showDone })}
      </div>
      <aside class="stack">
        ${graph.issues.length === 0
          ? null
          : rankedList(
              repo,
              "Ready now",
              ready,
              (r) =>
                `ready · ${pillarOf(r)}${graph.flow?.has(r.issue.id) ? "flow · " : ""}${
                  r.holdsUp === 0
                    ? "holds nothing up"
                    : `finishing it frees ${r.holdsUp}`
                }`,
              "Nothing is ready: everything open waits for something.",
              tellHref,
              {
                writer:
                  ctx.auth.user !== undefined &&
                  ctx.auth.user.kind !== "agent" &&
                  canWrite(db, repo, ctx.auth.user),
                by: new Map([...firstMarksInRepo(db, repo.id)].map(([id, m]) => [id, m.by])),
              },
            )}
        ${pillars === undefined
          ? null
          : pillarList(
              repo,
              pillarRows(repo, graph, readySet, marks, pillars, ask),
            )}
        ${rankedList(
          repo,
          "Blocked on",
          blocked,
          (r) =>
            `${wordFor(r.issue, readySet, marks)} · ${pillarOf(r)}${r.waitsFor > 0 ? `waits for ${r.waitsFor} · ` : ""}holds up ${r.holdsUp}`,
          "Nothing open holds anything up.",
          tellHref,
        )}
      </aside>
    </div>`;
  const response = page({
    ctx,
    title: `Map · ${repo.name}`,
    crumbs: crumbsFor(repo),
    // The card shows what a signed-out reader sees: only a public repo has one.
    ...(repo.visibility === "public"
      ? { ogImage: `/og/map/${repo.ownerName}~${repo.name}.png` }
      : {}),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: mapCss,
    scriptJs: `${liveRegionsJs}\n${mapViewJs}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/**
 * The map's answer without its closed history (#6176): `issues` keeps the
 * open ones and `edges` those between them. Everything computed on the whole
 * graph, `counts.done` included, stays as it was.
 */
export function withoutDone(json: Record<string, unknown>): Record<string, unknown> {
  const issues = (json.issues as { number: number; state: string }[]).filter(
    (i) => i.state === "open",
  );
  const open = new Set(issues.map((i) => i.number));
  const edges = (json.edges as { issue?: number; blockedBy?: number }[]).filter(
    (e) => open.has(e.issue ?? -1) && open.has(e.blockedBy ?? -1),
  );
  return { ...json, issues, edges };
}

/**
 * The map as data, for the crew and the tick: the same three lists,
 * `working`, the issues the crew is on right now, and every issue with its
 * word and the words counted.
 */
export function mapJson(
  repo: Repo,
  graph: Graph,
  marks: Marks = NO_MARKS,
  pillars?: PillarView,
  ask: readonly AskToLiveCount[] = [],
  held?: { holds: ReadonlyMap<number, MapHold>; startable: readonly number[] },
): Record<string, unknown> {
  const ready = readyNow(graph);
  const readySet = new Set(ready.map((r) => r.issue.id));
  const free = held === undefined ? undefined : new Set(held.startable);
  const startable = ready
    .filter(
      (r) =>
        r.issue.assigneeName === null &&
        wordFor(r.issue, readySet, marks) === "ready" &&
        (free === undefined || free.has(r.issue.number)),
    )
    .map((r) => r.issue.number);
  const brief = (i: Issue) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    assignee: i.assigneeName,
    word: wordFor(i, readySet, marks),
    ...(pillars === undefined ? {} : { pillar: pillars.of.get(i.id) ?? null }),
    ...(i.state === "closed" && i.closeReason !== null
      ? { closeReason: i.closeReason }
      : {}),
    ...(marks.why.has(i.id) ? { parkedBecause: marks.why.get(i.id) } : {}),
    ...(marks.deferred.has(i.id) && i.state === "open"
      ? { deferredBecause: marks.deferred.get(i.id) }
      : {}),
    ...(marks.onHold.has(i.id) ? { heldBy: marks.onHold.get(i.id) } : {}),
  });
  return {
    repo: { owner: repo.ownerName, name: repo.name },
    // Who the crew takes direction from (`crew/direct.ts`).
    crewOutsiders: repo.crewOutsiders,
    ready: ready.map((r) => ({
      ...brief(r.issue),
      holdsUp: r.holdsUp,
      ...(held === undefined ? {} : { held: held.holds.get(r.issue.number) ?? null }),
    })),
    // What a builder may start now: ready, unassigned, no filter holding it.
    startable,
    blockedOn: blockedOn(graph).map((r) => ({
      ...brief(r.issue),
      holdsUp: r.holdsUp,
      waitsFor: r.waitsFor,
    })),
    critical: criticalPath(graph).map((i) => i.number),
    working: graph.issues
      .filter((i) => marks.crew.has(i.id))
      .map((i) => i.number),
    issues: graph.issues.map(brief),
    // What the crew gave up on and the planner now holds: never only a word.
    parkedTwice: marks.twice.map((t) => ({
      number: t.number,
      title: t.title,
      reasons: t.reasons,
    })),
    counts: {
      ...countWords(graph.issues.map((i) => wordFor(i, readySet, marks))),
      ready: startable.length,
    },
    edges: graph.edges.map((e) => {
      const a = graph.issues.find((i) => i.id === e.issueId);
      const b = graph.issues.find((i) => i.id === e.blockedById);
      return { issue: a?.number, blockedBy: b?.number };
    }),
    // For a repository with pillars: its open work by pillar (`pillar` null
    // is the work that names none), and what merged this week by pillar.
    ...(pillars === undefined
      ? {}
      : {
          pillars: pillarRows(repo, graph, readySet, marks, pillars, ask).map(
            (r) => ({
              pillar: r.name,
              ...(r.umbrella === undefined ? {} : { umbrella: r.umbrella }),
              open: r.open,
              ready: r.ready,
              blocked: r.blocked,
            }),
          ),
          mergedByPillar: {
            days: PILLAR_DAYS,
            counts: pillars.merged.map((count) => {
              const asked = ask.find((a) => a.pillar === count.pillar);
              return asked === undefined
                ? count
                : { ...count, askToLive: asked.askToLive ?? null };
            }),
          },
        }),
  };
}
