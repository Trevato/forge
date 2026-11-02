/**
 * The week's budget as pipes: sources (your notes, the planner, the
 * builders, reviews) flowing through a valve per repository to shipped,
 * with real spend as the width. Plain data out for the page, the terminal
 * and the MCP. The preview is the valves applied to the queue as it stands,
 * by the same rule the next tick uses (`valve_gate.ts`); what a turn did is
 * the starts since it.
 */

import type { Database } from "bun:sqlite";
import { listQueued } from "../core/runs.ts";
import { getRepoById } from "../core/repos.ts";
import { byDials } from "../crew/team_share.ts";
import { modeOf, suggestedLevel, type Mode } from "./valve.ts";
import { gateQueue } from "./valve_gate.ts";
import {
  lastTurns,
  looksThisWeek,
  notesThisWeek,
  readLevels,
  shippedThisWeek,
  SOURCES,
  spendThisWeek,
  startsSince,
  type Source,
} from "./valve_store.ts";

const MAX_VALVES = 24;

export interface ValveRow {
  readonly repoId: string;
  readonly slug: string;
  readonly level: number;
  readonly mode: Mode;
  readonly usd: number;
  readonly runs: number;
  readonly notes: number;
  readonly shipped: number;
  /** The next tick, from the queue now: starting in turn, yielding to others, held shut. */
  readonly next: { readonly queued: number; readonly goes: number; readonly yields: number; readonly held: number };
  /** The latest turn and what has happened since it. */
  readonly turned?: { readonly by: string; readonly at: string; readonly from: number; readonly to: number; readonly started: number };
  /** What where you look suggests, when it differs enough from the valve. */
  readonly suggestion?: number;
  readonly looks: number;
}

export interface Pipes {
  readonly usd: number;
  readonly notes: number;
  readonly shipped: number;
  readonly sources: readonly { readonly source: Source | "notes"; readonly usd: number; readonly runs: number }[];
  /** Each pipe from a source into a repository, in dollars (notes carry none, only a count of runs). */
  readonly flows: readonly { readonly source: Source | "notes"; readonly repoId: string; readonly usd: number; readonly runs: number }[];
  readonly valves: readonly ValveRow[];
}

export function readPipes(db: Database, viewerId: string, now = Date.now()): Pipes {
  const spend = spendThisWeek(db, now);
  const notes = notesThisWeek(db, now);
  const shipped = shippedThisWeek(db, now);
  const levels = readLevels(db);
  const turns = lastTurns(db);
  const looks = looksThisWeek(db, viewerId, now);
  const gated = gateQueue(db, byDials(db, listQueued(db, "agent", 50)), now);
  const yielding = new Set(gated.yielding.map((r) => r.id));
  const queue = new Map<string, { queued: number; goes: number; yields: number; held: number }>();
  const slot = (id: string) => {
    let s = queue.get(id);
    if (s === undefined) queue.set(id, (s = { queued: 0, goes: 0, yields: 0, held: 0 }));
    return s;
  };
  for (const r of gated.order) {
    const s = slot(r.repoId);
    s.queued++;
    if (yielding.has(r.id)) s.yields++;
    else s.goes++;
  }
  for (const r of gated.held) {
    const s = slot(r.repoId);
    s.queued++;
    s.held++;
  }

  const ids = new Set<string>([
    ...levels.keys(),
    ...queue.keys(),
    ...notes.keys(),
    ...shipped.keys(),
    ...spend.map((s) => s.repoId),
  ]);
  const usdOf = (id: string) => spend.filter((s) => s.repoId === id).reduce((a, s) => a + s.usd, 0);
  const rows: ValveRow[] = [];
  for (const id of ids) {
    const repo = getRepoById(db, id);
    if (repo === undefined) continue;
    const level = levels.get(id) ?? 100;
    const turn = turns.get(id);
    const suggestion = suggestedLevel(looks, id, level);
    rows.push({
      repoId: id,
      slug: `${repo.ownerName}/${repo.name}`,
      level,
      mode: modeOf(level),
      usd: usdOf(id),
      runs: spend.filter((s) => s.repoId === id).reduce((a, s) => a + s.runs, 0),
      notes: notes.get(id) ?? 0,
      shipped: shipped.get(id) ?? 0,
      next: queue.get(id) ?? { queued: 0, goes: 0, yields: 0, held: 0 },
      ...(turn === undefined ? {} : { turned: { by: turn.by, at: turn.at, from: turn.from, to: turn.to, started: startsSince(db, id, turn.at) } }),
      ...(suggestion === undefined ? {} : { suggestion }),
      looks: looks.find((l) => l.repoId === id)?.n ?? 0,
    });
  }
  rows.sort((a, b) => b.usd - a.usd || a.slug.localeCompare(b.slug));
  rows.length = Math.min(rows.length, MAX_VALVES);
  const shown = new Set(rows.map((r) => r.repoId));
  const sources = [
    { source: "notes" as const, usd: 0, runs: [...notes.values()].reduce((a, n) => a + n, 0) },
    ...SOURCES.map((source) => ({
      source,
      usd: spend.filter((s) => s.source === source).reduce((a, s) => a + s.usd, 0),
      runs: spend.filter((s) => s.source === source).reduce((a, s) => a + s.runs, 0),
    })),
  ];
  return {
    usd: spend.reduce((a, s) => a + s.usd, 0),
    notes: sources[0]!.runs,
    shipped: [...shipped.values()].reduce((a, n) => a + n, 0),
    sources,
    flows: [
      ...[...notes].map(([repoId, runs]) => ({ source: "notes" as const, repoId, usd: 0, runs })),
      ...spend,
    ].filter((f) => shown.has(f.repoId)),
    valves: rows,
  };
}
