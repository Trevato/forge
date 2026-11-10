/**
 * The way a test bounds what a page costs without a clock (#7824).
 *
 * Wall-clock is a coin flip in a loaded check cell and is never judged in a
 * pull (see `budget.ts`). Work is countable: the SQL statements a request
 * runs, the bytes it sends. A regression (an N+1, a page that stops using its
 * cache) raises the count in every run, so a count fails a pull reliably where
 * a stopwatch cannot.
 */
import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { gitRecord } from "../../src/perf/live.ts";
import { once, statements } from "./statements.ts";

/** The fewest SQL statements one request for `url` costs (server and test share `db`). */
export async function requestStatements(db: Database, url: string, init?: RequestInit): Promise<number> {
  return statements(db, async () => {
    await (await fetch(url, init)).text();
  });
}

/** Asserts counted work `measured` is no larger than `max`. */
export function expectWork(measured: number, opts: { max: number }): void {
  expect(measured).toBeLessThanOrEqual(opts.max);
}

/** The git processes `work` spawns, counted from the spawn record (every `runGit` notes one). */
export async function gitSpawns(work: () => Promise<void> | void): Promise<number> {
  const total = () => gitRecord.patterns().reduce((n, k) => n + gitRecord.traffic(k, 0).length, 0);
  const before = total();
  await work();
  return total() - before;
}

/** What one warm request cost: counted work for the pull, the clock only to print. */
export interface PageWork {
  status: number;
  statements: number;
  git: number;
  /** Server-Timing phases in ms, slowest first. */
  phases: Array<{ name: string; ms: number }>;
  ms: number;
}

/** Parses a Server-Timing header into phases, slowest first. */
export function parsePhases(header: string): Array<{ name: string; ms: number }> {
  return header
    .split(",")
    .map((p) => p.trim().split(";"))
    .map(([name, ...rest]) => ({ name: name!, ms: Number(rest.find((r) => r.startsWith("dur="))?.slice(4) ?? 0) }))
    .filter((p) => p.name !== "" && p.name !== "lag" && Number.isFinite(p.ms))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * Walks one URL warm: a first request fills the caches, a second is measured
 * (statements, git spawns, Server-Timing) with no wait for rest, so a sweep of
 * every page stays in seconds. Stray background work only raises a count.
 */
export async function pageWork(db: Database, url: string, init?: RequestInit): Promise<PageWork> {
  await (await fetch(url, init)).arrayBuffer();
  let status = 0;
  let header = "";
  let ms = 0;
  let git = Number.POSITIVE_INFINITY;
  const count = await once(db, async () => {
    const g = await gitSpawns(async () => {
      const t = performance.now();
      const res = await fetch(url, init);
      await res.arrayBuffer();
      ms = performance.now() - t;
      status = res.status;
      header = res.headers.get("server-timing") ?? "";
    });
    git = Math.min(git, g);
  });
  return { status, statements: count, git, phases: parsePhases(header), ms };
}
