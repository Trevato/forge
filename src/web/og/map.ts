/**
 * The map's card: the plan as a thumbnail, and the words counted.
 *
 * It reads what the map page reads — the graph, the ready list, the
 * critical path, the crew's runs, the pulls that would close an issue —
 * through the same functions (`web/pages/map.ts`), so the picture and the
 * page cannot disagree on a word. The route hands it a graph read as
 * nobody (`pages/og.ts`); from there on it is plain data in, a card out.
 */

import { criticalPath, readyNow, type Graph } from "../../core/dependencies.ts";
import { countWords, layout, wordFor, type Marks, type Word } from "../pages/map.ts";
import { cachedLayout } from "../map_cache.ts";
import type { CardInput } from "./card.ts";
import type { GraphEdge, GraphFigure, GraphNode } from "./graph.ts";

/** Unlinked issues are drawn only when nothing is linked, and then this many rows. */
const ISLAND_ROWS = 4;

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/**
 * The thumbnail's data from a graph: the chains when there are any (the
 * unlinked issues are counted, not drawn — a grid of loose cards says
 * nothing at this size), otherwise the first few rows of loose ones.
 */
export function graphFigure(
  graph: Graph,
  words: ReadonlyMap<string, Word>,
  critical: readonly string[],
): GraphFigure | undefined {
  const placed = cachedLayout(graph, layout);
  const chained = placed.islandFrom > 0;
  const drawn = placed.nodes.filter((n) => (chained ? !n.island : n.level < ISLAND_ROWS));
  if (drawn.length === 0) return undefined;
  const index = new Map(drawn.map((n, i) => [n.issue.id, i]));
  const onPath = new Set(critical);
  const chain = new Set<string>();
  for (let i = 0; i + 1 < critical.length; i++) chain.add(`${critical[i]}>${critical[i + 1]}`);
  const via = new Map(placed.routes.map((r) => [`${r.blockedById}>${r.issueId}`, r.via]));
  const nodes: GraphNode[] = drawn.map((n) => ({
    level: n.level,
    slot: n.slot,
    word: words.get(n.issue.id) ?? "blocked",
    critical: onPath.has(n.issue.id),
  }));
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    const from = index.get(e.blockedById);
    const to = index.get(e.issueId);
    if (from === undefined || to === undefined) continue;
    const key = `${e.blockedById}>${e.issueId}`;
    edges.push({
      from,
      to,
      via: (via.get(key) ?? []).map((v) => ({
        level: v.level,
        gutter: v.gutter,
        lane: v.lane,
        lanes: v.lanes,
      })),
      critical: chain.has(key),
      done: nodes[from]!.word === "done" || nodes[to]!.word === "done",
    });
  }
  return {
    kind: "graph",
    width: Math.max(...nodes.map((n) => n.slot)) + 1,
    levels: Math.max(...nodes.map((n) => n.level)) + 1,
    nodes,
    edges,
  };
}

/** The lines under the title: how much is open, how long the chain still to go is, what is next. */
export function mapLines(
  open: number,
  path: readonly { number: number }[],
  next: { number: number; title: string } | undefined,
): string[] {
  if (open === 0) return ["Nothing open: every issue on the map is done."];
  const lines = [`${open} open ${plural(open, "issue")}`];
  lines.push(
    path.length > 1
      ? `Critical path: ${path.length} issues, #${path[0]!.number} → #${path.at(-1)!.number}`
      : "None waits on another",
  );
  if (next !== undefined) lines.push(`Next: #${next.number} ${next.title}`);
  return lines;
}

/** The counts along the foot: the four words that move, and what is done. */
export function mapStat(counts: Record<Word, number>): string {
  const parts = [
    `${counts.ready} ready`,
    `${counts.working} working`,
    `${counts.blocked} blocked`,
  ];
  const waiting = counts.waiting + counts.held;
  if (waiting > 0) parts.push(`${waiting} waiting`);
  parts.push(`${counts.done} done`);
  return parts.join(" · ");
}

/** A repository's map card, from its graph as nobody reads it and its marks. */
export function mapInput(
  title: string,
  graph: Graph,
  marks: Marks,
  /** Names a stretch of the work; the route times it, a test need not. */
  stretch: <T>(name: string, work: () => T) => T = (_name, work) => work(),
): CardInput {
  const ready = readyNow(graph);
  const path = criticalPath(graph);
  const readySet = new Set(ready.map((r) => r.issue.id));
  const words = new Map(graph.issues.map((i) => [i.id, wordFor(i, readySet, marks)]));
  const open = graph.issues.filter((i) => i.state === "open").length;
  // The thumbnail draws what is open: done issues are counted in the caption, not drawn.
  const live = new Set(graph.issues.filter((i) => i.state === "open").map((i) => i.id));
  const figure = stretch("layout", () =>
    graphFigure(
      {
        ...graph,
        issues: graph.issues.filter((i) => live.has(i.id)),
        edges: graph.edges.filter((e) => live.has(e.issueId) && live.has(e.blockedById)),
      },
      words,
      path.map((i) => i.id),
    ),
  );
  // Next is what a free hand would take: ready, and nobody on it yet.
  const next = ready.find((r) => words.get(r.issue.id) === "ready")?.issue;
  return {
    kind: "map",
    title,
    lines: mapLines(open, path, next),
    stat: mapStat(countWords([...words.values()])),
    ...(figure === undefined ? {} : { figure }),
  };
}
