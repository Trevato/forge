/**
 * The rolling record of real requests (#7559): per route pattern, the
 * requests of the last `WINDOW_MS` with their total and each Server-Timing
 * phase. Memory only, sized by time: older samples are dropped, and a route so
 * busy that it passes `MAX_SAMPLES` is thinned to every second sample, which
 * keeps the whole window and its percentiles. Keys are router patterns, never
 * paths, ids or query strings; nothing about the viewer is kept but signed in
 * or not. `first` is when a pattern was first seen, so a busy route is not
 * mistaken for a young one.
 */

import { classOf, createTrafficLedger, type TrafficClass, type TrafficLedger, type TrafficWho } from "./traffic.ts";

export const WINDOW_MS = 15 * 60_000;
export const MAX_SAMPLES = 20_000;
export const MAX_PATTERNS = 200;
const MAX_PATTERN = 200;
const MAX_PHASES = 16;

export interface PhaseSample {
  readonly name: string;
  readonly ms: number;
  readonly hit: boolean;
}

export interface Sample {
  readonly at: number;
  readonly ms: number;
  readonly signedIn: boolean;
  /** An unauthenticated request whose User-Agent names a crawler (`http/crawl.ts`). */
  readonly crawler?: boolean;
  /** An unauthenticated, browser-looking read of a deep git page (#8199). */
  readonly deepStranger?: boolean;
  /** The forge asking itself: a loopback or proxy peer that names no client (`http/peer.ts`). */
  readonly internal?: boolean;
  /** Answered 429. */
  readonly refused?: boolean;
  readonly phases: readonly PhaseSample[];
}

export interface PerfRecord {
  /**
   * Add one request; a pattern that is not a route pattern is dropped from the
   * samples. `who` goes only into the minute totals (`traffic.ts`): a sample
   * keeps nothing about the viewer but signed in or not.
   */
  add(pattern: string, sample: Sample, who?: TrafficWho): void;
  /** Requests for `pattern` at or after `since`. */
  traffic(pattern: string, since: number): Sample[];
  /** When `pattern` was first seen in this process, undefined if never. */
  first(pattern: string): number | undefined;
  patterns(): string[];
  /** Who used the answering time, by the minute: exact however the samples are thinned. */
  readonly ledger: TrafficLedger;
}

const validPattern = (p: string): boolean =>
  p.startsWith("/") && p.length <= MAX_PATTERN && !/[?#\s\u0000-\u001f]/.test(p);

/** Nearest-rank percentile of `xs`, null when empty. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

/** `valid` says which keys are kept: route patterns here, `git <subcommand>` in `git.ts`. */
export function createPerfRecord(valid: (key: string) => boolean = validPattern): PerfRecord {
  const real = new Map<string, Sample[]>();
  const firsts = new Map<string, number>();
  const ledger = createTrafficLedger();
  return {
    ledger,
    add(pattern, sample, who) {
      if (!Number.isFinite(sample.ms) || sample.ms < 0) return;
      ledger.note(sample.at, sample.ms, classOf(sample), sample.refused === true, who);
      if (!valid(pattern)) return;
      let list = real.get(pattern);
      if (list === undefined) {
        if (real.size >= MAX_PATTERNS) return;
        list = [];
        real.set(pattern, list);
        firsts.set(pattern, sample.at);
      }
      const phases = sample.phases
        .filter((p) => Number.isFinite(p.ms) && p.ms >= 0)
        .slice(0, MAX_PHASES);
      list.push({ ...sample, phases });
      // A minute of slack past the window, so the drop is rare, not per request.
      if (list[0]!.at < sample.at - WINDOW_MS - 60_000) {
        const keep = list.findIndex((s) => s.at >= sample.at - WINDOW_MS);
        list.splice(0, keep === -1 ? list.length : keep);
      }
      if (list.length > MAX_SAMPLES) {
        const thinned = list.filter((_, i) => i % 2 === 1);
        list.length = 0;
        list.push(...thinned);
      }
    },
    traffic: (pattern, since) => (real.get(pattern) ?? []).filter((s) => s.at >= since),
    first: (pattern) => firsts.get(pattern),
    patterns: () => [...real.keys()],
  };
}

export interface PhaseStat {
  readonly name: string;
  readonly p95: number;
  readonly share: number;
  readonly hits: number;
  readonly n: number;
}

export interface RouteStat {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Phases, slowest p95 first. */
  readonly phases: readonly PhaseStat[];
}

/** p50/p95/p99 of the totals, and each phase's p95, its share of the total p95 and its cache hits. */
export function summarize(samples: readonly Sample[]): RouteStat | null {
  if (samples.length === 0) return null;
  const totals = samples.map((s) => s.ms);
  const p95 = percentile(totals, 95)!;
  const byName = new Map<string, PhaseSample[]>();
  for (const s of samples)
    for (const ph of s.phases) {
      const list = byName.get(ph.name);
      if (list === undefined) byName.set(ph.name, [ph]);
      else list.push(ph);
    }
  const phases = [...byName].map(([name, list]) => {
    const own = percentile(list.map((x) => x.ms), 95)!;
    return { name, p95: own, share: p95 > 0 ? Math.min(1, own / p95) : 0, hits: list.filter((x) => x.hit).length, n: list.length };
  });
  phases.sort((a, b) => b.p95 - a.p95);
  return { n: samples.length, p50: percentile(totals, 50)!, p95, p99: percentile(totals, 99)!, phases };
}

/** `app;dur=1.0, kpis;dur=4400.0;desc="hit"` as the phases it names; `app`, `db` included. */
export function parseServerTiming(header: string): PhaseSample[] {
  const out: PhaseSample[] = [];
  for (const part of header.split(",").slice(0, MAX_PHASES)) {
    const m = /^\s*([a-z][a-z0-9.-]{0,15});dur=([0-9.]+)(;desc="hit")?\s*$/.exec(part);
    if (m) out.push({ name: m[1]!, ms: Number(m[2]), hit: m[3] !== undefined });
  }
  return out;
}

export interface CrawlerShare {
  readonly requests: number;
  readonly crawlerRequests: number;
  /** Summed time to answer, ms, of every request and of the crawlers' alone. */
  readonly ms: number;
  readonly crawlerMs: number;
  /** The same for anonymous readers with a browser's User-Agent on the deep git pages (#8199). */
  readonly strangerRequests: number;
  readonly strangerMs: number;
  /** crawlerMs / ms, 0 when nothing was answered. */
  readonly share: number;
}

/** What share of the server's answering time crawlers took, from `since` on. */
export function crawlerShare(record: PerfRecord, since: number): CrawlerShare {
  let requests = 0, crawlerRequests = 0, ms = 0, crawlerMs = 0, strangerRequests = 0, strangerMs = 0;
  for (const pattern of record.patterns())
    for (const s of record.traffic(pattern, since)) {
      requests++;
      ms += s.ms;
      if (s.crawler === true) {
        crawlerRequests++;
        crawlerMs += s.ms;
      } else if (s.deepStranger === true) {
        strangerRequests++;
        strangerMs += s.ms;
      }
    }
  return { requests, crawlerRequests, ms, crawlerMs, strangerRequests, strangerMs, share: ms > 0 ? crawlerMs / ms : 0 };
}

export interface ScannedClass {
  requests: number;
  ms: number;
  refused: number;
}

/** The per-class totals counted again from the samples themselves, from `since` on: what the probe compares the ledger with. */
export function scanTraffic(record: PerfRecord, since: number, to: number): Record<TrafficClass, ScannedClass> {
  const out: Record<TrafficClass, ScannedClass> = {
    people: { requests: 0, ms: 0, refused: 0 },
    crawlers: { requests: 0, ms: 0, refused: 0 },
    deep: { requests: 0, ms: 0, refused: 0 },
    other: { requests: 0, ms: 0, refused: 0 },
    internal: { requests: 0, ms: 0, refused: 0 },
  };
  for (const pattern of record.patterns())
    for (const s of record.traffic(pattern, since)) {
      if (s.at > to) continue;
      const row = out[classOf(s)];
      row.requests++;
      row.ms += s.ms;
      if (s.refused === true) row.refused++;
    }
  return out;
}
