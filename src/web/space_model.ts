/**
 * The space (#10444): the map as a plane to move through. This module is
 * the whole of its arithmetic and nothing else: plain data in (a
 * repository's work, as `space_read.ts` gathers it), plain data out (every
 * region, cluster and issue placed in one world, in compact arrays the
 * canvas draws from). No database, no HTML.
 *
 * The world is one rectangle. Pillars are regions of it, cut by recursive
 * bisection (a treemap) so that area follows open work. Inside a region the
 * issues sit in clusters by state, each cluster a grid of square cells. An
 * issue that landed this week also has a slot in the "in review" cluster of
 * its region, where it was before it landed, so the scrubber can move it.
 * Units are world units; the client scales them to pixels.
 */

/** Where an issue sits in its pillar's life, left to right on the page. */
export const STATES = ["ready", "building", "review", "waiting", "landed"] as const;
export type State = (typeof STATES)[number];

/** The words the map page uses for a card, mapped to a cluster. */
export function stateOf(word: string): State {
  switch (word) {
    case "done":
      return "landed";
    case "working":
      return "building";
    case "held":
    case "waiting":
      return "review";
    case "ready":
      return "ready";
    default:
      return "waiting"; // blocked, deferred, parked
  }
}

export const DAY_MS = 86_400_000;
/** How far back the scrubber goes. */
export const WEEK_MS = 7 * DAY_MS;

export interface SpaceIssue {
  readonly number: number;
  readonly title: string;
  /** Index into `SpaceInput.pillars`; -1 for work that serves none. */
  readonly pillar: number;
  readonly state: State;
  readonly createdAt: number;
  /** Epoch ms; 0 while open. */
  readonly closedAt: number;
  /** The open pull that would close it, or 0. */
  readonly pull: number;
  /** Why a person holds that pull, or "". */
  readonly hold: string;
  /** Latest check verdict of that pull's head: "ok", "failed", "running" or "". */
  readonly check: string;
}

export interface SpaceRun {
  readonly actor: string;
  readonly issue: number;
  readonly startedAt: number;
  /** Epoch ms; 0 while it runs. */
  readonly endedAt: number;
}

export interface SpaceInput {
  readonly repo: string;
  readonly now: number;
  /** Pillar names in order; "No pillar" is appended by the reader when needed. */
  readonly pillars: readonly { name: string; merged: number }[];
  /** Open issues, and those closed in the last week. Nothing older. */
  readonly issues: readonly SpaceIssue[];
  /** Agent runs of the last week, newest first. */
  readonly runs: readonly SpaceRun[];
}

export interface Region {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly open: number;
  readonly ready: number;
  readonly blocked: number;
  readonly landed: number;
  readonly merged: number;
  /** landed ÷ (open + landed) over the window, 0..1. */
  readonly progress: number;
  /** Whether anything moved in the window: a landing, or someone building. */
  readonly moving: boolean;
}

/** [region, state index, x, y, w, h, cell, count] */
export type ClusterRow = [number, number, number, number, number, number, number, number];
/** [number, cluster, x, y, created, closed, title, pull, bx, by, bcluster, hold, check] */
export type IssueRow = [number, number, number, number, number, number, string, number, number, number, number, string, string];

export interface Space {
  readonly repo: string;
  readonly now: number;
  readonly weekStart: number;
  readonly world: { readonly w: number; readonly h: number };
  readonly states: readonly State[];
  readonly regions: Region[];
  readonly clusters: ClusterRow[];
  readonly issues: IssueRow[];
  readonly crew: { name: string; runs: [number, number, number][] }[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Slice-and-dice by recursive bisection: `weights` (descending) cut `rect`
 * into one rectangle each, areas in proportion. The list is split where the
 * two halves weigh most nearly alike, along the longer side.
 */
export function treemap(weights: readonly number[], rect: Rect): Rect[] {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [{ ...rect }];
  const total = weights.reduce((a, b) => a + b, 0);
  let cut = 1;
  let acc = weights[0]!;
  let best = Math.abs(total - 2 * acc);
  for (let i = 1; i < weights.length - 1; i++) {
    acc += weights[i]!;
    const gap = Math.abs(total - 2 * acc);
    if (gap < best) {
      best = gap;
      cut = i + 1;
    }
  }
  const left = weights.slice(0, cut);
  const lw = left.reduce((a, b) => a + b, 0);
  const share = total === 0 ? 0.5 : lw / total;
  if (rect.w >= rect.h) {
    const w = rect.w * share;
    return [
      ...treemap(left, { x: rect.x, y: rect.y, w, h: rect.h }),
      ...treemap(weights.slice(cut), { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }),
    ];
  }
  const h = rect.h * share;
  return [
    ...treemap(left, { x: rect.x, y: rect.y, w: rect.w, h }),
    ...treemap(weights.slice(cut), { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }),
  ];
}

/** The largest square cell with which `n` of them fit a `w`×`h` rectangle, and the columns that gives. */
export function gridFor(n: number, w: number, h: number): { cell: number; cols: number } {
  if (n <= 0 || w <= 0 || h <= 0) return { cell: Math.max(0, Math.min(w, h)), cols: 1 };
  let cell = Math.sqrt((w * h) / n);
  while (cell > 0.01 && Math.floor(w / cell) * Math.floor(h / cell) < n) cell *= 0.97;
  return { cell, cols: Math.max(1, Math.floor(w / cell)) };
}

/** Room above a region's or cluster's contents, for its words. */
const REGION_HEAD = 70;
const CLUSTER_HEAD = 30;
const GAP = 14;
/** The smallest cell a card is legible in, at the deepest zoom the page allows for it. */
const MIN_CELL = 40;

/** The world's size for `n` slots: a 1.6 : 1 plane with room for every cell at `MIN_CELL`. */
export function worldFor(n: number): { w: number; h: number } {
  const area = Math.max(1_600_000, n * MIN_CELL * MIN_CELL * 2.4);
  const h = Math.sqrt(area / 1.6);
  return { w: Math.round(h * 1.6), h: Math.round(h) };
}

const inset = (r: Rect, top: number, pad: number): Rect => ({
  x: r.x + pad,
  y: r.y + top,
  w: Math.max(1, r.w - 2 * pad),
  h: Math.max(1, r.h - top - pad),
});

/** Place the work of one repository. Pure: the same input gives the same space. */
export function buildSpace(input: SpaceInput): Space {
  const weekStart = input.now - WEEK_MS;
  const names = input.pillars.map((p) => p.name);
  const loose = input.issues.some((i) => i.pillar < 0);
  if (loose) names.push("No pillar");
  if (names.length === 0) names.push("All work");
  const regionOf = (i: SpaceIssue): number => (i.pillar >= 0 ? i.pillar : loose ? names.length - 1 : 0);

  // Which issue sits in which region and cluster. A landed one also holds a
  // "before" slot in review.
  const per = names.map(() => STATES.map(() => [] as { issue: SpaceIssue; before: boolean }[]));
  const tally = names.map(() => ({ open: 0, ready: 0, blocked: 0, landed: 0 }));
  for (const issue of input.issues) {
    const r = regionOf(issue);
    const s = STATES.indexOf(issue.state);
    per[r]![s]!.push({ issue, before: false });
    const t = tally[r]!;
    if (issue.state === "landed") {
      t.landed++;
      per[r]![STATES.indexOf("review")]!.push({ issue, before: true });
    } else {
      t.open++;
      if (issue.state === "ready") t.ready++;
      if (issue.state === "waiting") t.blocked++;
    }
  }

  const slots = per.reduce((a, r) => a + r.reduce((b, c) => b + c.length, 0), 0);
  const world = worldFor(slots);
  const weights = tally.map((t) => Math.max(1, t.open) + t.landed * 0.5);
  const order = weights.map((w, i) => i).sort((a, b) => weights[b]! - weights[a]! || a - b);
  const rects = treemap(
    order.map((i) => weights[i]!),
    { x: 0, y: 0, w: world.w, h: world.h },
  );

  const runsByActor = new Map<string, [number, number, number][]>();
  for (const run of input.runs) {
    const list = runsByActor.get(run.actor) ?? [];
    list.push([run.issue, run.startedAt, run.endedAt]);
    runsByActor.set(run.actor, list);
  }

  const regions: Region[] = names.map((name, i) => {
    const t = tally[i]!;
    const building = per[i]![STATES.indexOf("building")]!.length;
    return {
      name,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      open: t.open,
      ready: t.ready,
      blocked: t.blocked,
      landed: t.landed,
      merged: input.pillars[i]?.merged ?? 0,
      progress: t.open + t.landed === 0 ? 0 : t.landed / (t.open + t.landed),
      moving: t.landed > 0 || building > 0,
    };
  });
  const clusters: ClusterRow[] = [];
  const issues: IssueRow[] = [];
  const byNumber = new Map<number, IssueRow>();
  const befores: [number, number, number, number][] = [];

  order.forEach((ri, k) => {
    const rect = rects[k]!;
    const placed = regions[ri]!;
    regions[ri] = { ...placed, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    const inner = inset(rect, REGION_HEAD, GAP);
    const used = STATES.map((_, s) => s).filter((s) => per[ri]![s]!.length > 0);
    const cutRects = treemap(
      used.map((s) => per[ri]![s]!.length).sort((a, b) => b - a),
      inner,
    );
    // The treemap wants descending weights; give each rectangle to the
    // cluster of that size, ties in state order.
    const bySize = [...used].sort((a, b) => per[ri]![b]!.length - per[ri]![a]!.length || a - b);
    const home = new Map<number, number>(); // state -> cluster index
    bySize.forEach((s, j) => {
      const box = cutRects[j]!;
      const body = inset(box, CLUSTER_HEAD, 4);
      const list = per[ri]![s]!;
      const { cell, cols } = gridFor(list.length, body.w, body.h);
      const ci = clusters.length;
      home.set(s, ci);
      clusters.push([ri, s, box.x, box.y, box.w, box.h, cell, list.length]);
      // Sort so the newest sit first, and "before" slots come last.
      const ordered = [...list].sort(
        (a, b) => Number(a.before) - Number(b.before) || b.issue.number - a.issue.number,
      );
      ordered.forEach((entry, n) => {
        const x = body.x + (n % cols) * cell + cell / 2;
        const y = body.y + Math.floor(n / cols) * cell + cell / 2;
        if (entry.before) {
          befores.push([entry.issue.number, x, y, ci]);
          return;
        }
        const i = entry.issue;
        const row: IssueRow = [i.number, ci, x, y, i.createdAt, i.closedAt, i.title, i.pull, 0, 0, -1, i.hold, i.check];
        byNumber.set(i.number, row);
        issues.push(row);
      });
    });
  });
  for (const [n, x, y, ci] of befores) {
    const row = byNumber.get(n);
    if (row) [row[8], row[9], row[10]] = [x, y, ci];
  }
  // An issue with no before slot starts where it ended.
  for (const row of issues) if (row[10] < 0) [row[8], row[9], row[10]] = [row[2], row[3], row[1]];

  const known = new Set(issues.map((r) => r[0]));
  return {
    repo: input.repo,
    now: input.now,
    weekStart,
    world,
    states: STATES,
    regions,
    clusters,
    issues,
    crew: [...runsByActor].map(([name, runs]) => ({
      name,
      runs: runs.filter((r) => known.has(r[0])),
    })),
  };
}
