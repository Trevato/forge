/**
 * Event-loop block attribution (#7559): which route was running when the loop
 * stalled. Each finished request is noted with its start and end; a stall of
 * `lateMs` ending at `at` blocked `[at - lateMs, at]`, and the requests whose
 * run overlaps that window are named, longest first. Patterns only.
 *
 * Each stall is also tallied by route (#9016): milliseconds and counts since
 * the process started, and the stalls of the last hour, so `GET /metrics`
 * shows a fix's before and after without the pod log. A stall is counted in
 * full against every route that ran across it — the same reading as the log
 * lines, so the sum over routes can exceed the wall time — and against
 * `NO_REQUEST` when none did.
 *
 * A stall no request ran across is counted against the background jobs that
 * did (#10834, `jobs.ts`), each as `job:<name>`; `NO_REQUEST` is left for a
 * stall nothing named ran across.
 */

/** A wake later than this is a stall, ms (#11069: 200, so a stall the probes would feel is named). */
export const LIMIT_MS = 200;
const RECENT = 256;
/** The window `StallTally.hour` covers, in ms. */
export const HOUR_MS = 3_600_000;
/** Stalls kept for the hour: a stall is over 200 ms, so 18,000 fill an hour solid. */
const HOUR_KEPT = 18_000;
/** The route a stall is counted against when no request ran across it. */
export const NO_REQUEST = "none";
/** The prefix a background job's name is tallied under, apart from routes. */
export const JOB_PREFIX = "job:";
/** The jobs that ran across `[from, to]` (`JobWatch.across`). */
export type JobsAcross = (from: number, to: number) => readonly string[];

export interface RouteStall {
  readonly route: string;
  readonly ms: number;
  readonly count: number;
}

export interface StallTally {
  /** Since the process started, by route; only ever grows. */
  readonly total: readonly RouteStall[];
  /** The last hour before `now`, by route, most milliseconds first. */
  readonly hour: readonly RouteStall[];
}

export interface Stall {
  readonly at: number;
  readonly lateMs: number;
  readonly routes: readonly string[];
  /** The background jobs running across it; read only when no request was. */
  readonly jobs: readonly string[];
}

export interface LoopWatch {
  /** A request for `pattern` ran from `start` to `end` (ms on one clock). */
  finished(pattern: string, start: number, end: number): void;
  /** A wake `lateMs` late at `at`; over the limit it is named. */
  stalled(lateMs: number, at: number): Stall | null;
  /** The stalls so far by route, the hour ending at `now` (same clock as `at`). */
  tally(now: number): StallTally;
  /**
   * The stalls noted at `from`..`to` (same clock as `at`), newest first. Read
   * from the end, so it costs the stalls in the window: at most one per
   * `LIMIT_MS`, 40 in a 10 s window (#11000).
   */
  within(from: number, to: number): readonly Stall[];
  /** Forget every request and stall noted so far; a test sharing the process's watch starts from nothing. */
  clear(): void;
}

/** What a stall is counted against: its routes, else its jobs, else `NO_REQUEST`. */
export const blamed = (s: Stall): readonly string[] =>
  s.routes.length > 0 ? s.routes : s.jobs.length > 0 ? s.jobs.map((j) => JOB_PREFIX + j) : [NO_REQUEST];

function byRoute(stalls: Iterable<Stall>): RouteStall[] {
  const sums = new Map<string, { ms: number; count: number }>();
  for (const s of stalls)
    for (const route of blamed(s)) {
      const t = sums.get(route) ?? { ms: 0, count: 0 };
      t.ms += s.lateMs;
      t.count += 1;
      sums.set(route, t);
    }
  return [...sums].map(([route, t]) => ({ route, ms: t.ms, count: t.count }));
}

export function createLoopWatch(limitMs = LIMIT_MS, jobsAcross: JobsAcross = () => []): LoopWatch {
  const recent: { pattern: string; start: number; end: number }[] = [];
  const totals = new Map<string, { ms: number; count: number }>();
  const hour: Stall[] = [];
  return {
    finished(pattern, start, end) {
      recent.push({ pattern, start, end });
      if (recent.length > RECENT) recent.shift();
    },
    stalled(lateMs, at) {
      if (!(lateMs > limitMs)) return null;
      const from = at - lateMs;
      const routes = [
        ...new Set(
          recent
            .filter((r) => r.end >= from && r.start <= at)
            .sort((a, b) => b.end - b.start - (a.end - a.start))
            .map((r) => r.pattern),
        ),
      ];
      const jobs = routes.length === 0 ? jobsAcross(from, at) : [];
      const stall = { at, lateMs, routes, jobs };
      for (const r of byRoute([stall])) {
        const t = totals.get(r.route) ?? { ms: 0, count: 0 };
        t.ms += r.ms;
        t.count += r.count;
        totals.set(r.route, t);
      }
      hour.push(stall);
      if (hour.length > HOUR_KEPT) hour.shift();
      return stall;
    },
    clear() {
      recent.length = 0;
      totals.clear();
      hour.length = 0;
    },
    tally(now) {
      while (hour.length > 0 && hour[0]!.at <= now - HOUR_MS) hour.shift();
      return {
        total: [...totals].map(([route, t]) => ({ route, ms: t.ms, count: t.count })).sort((a, b) => (a.route < b.route ? -1 : 1)),
        hour: byRoute(hour.filter((s) => s.at <= now)).sort((a, b) => b.ms - a.ms || (a.route < b.route ? -1 : 1)),
      };
    },
    within(from, to) {
      const out: Stall[] = [];
      for (let i = hour.length - 1; i >= 0; i--) {
        const s = hour[i]!;
        if (s.at < from) break;
        if (s.at <= to) out.push(s);
      }
      return out;
    },
  };
}

/** The stall as a finding line. */
export const stallLine = (s: Stall): string =>
  `event loop blocked ${Math.round(s.lateMs)} ms; running then: ${
    s.routes.length > 0 ? s.routes.join(", ") : s.jobs.length > 0 ? `no request; jobs ${s.jobs.join(", ")}` : "no request"
  }`;
