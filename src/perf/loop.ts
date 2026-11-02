/**
 * Event-loop block attribution (#7559): which route was running when the loop
 * stalled. Each finished request is noted with its start and end; a stall of
 * `lateMs` ending at `at` blocked `[at - lateMs, at]`, and the requests whose
 * run overlaps that window are named, longest first. Patterns only; the stall
 * is logged, not kept.
 */

export const LIMIT_MS = 250;
const RECENT = 256;

export interface Stall {
  readonly at: number;
  readonly lateMs: number;
  readonly routes: readonly string[];
}

export interface LoopWatch {
  /** A request for `pattern` ran from `start` to `end` (ms on one clock). */
  finished(pattern: string, start: number, end: number): void;
  /** A wake `lateMs` late at `at`; over the limit it is named. */
  stalled(lateMs: number, at: number): Stall | null;
}

export function createLoopWatch(limitMs = LIMIT_MS): LoopWatch {
  const recent: { pattern: string; start: number; end: number }[] = [];
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
      return { at, lateMs, routes };
    },
  };
}

/** The stall as a finding line. */
export const stallLine = (s: Stall): string =>
  `event loop blocked ${Math.round(s.lateMs)} ms; running then: ${s.routes.length === 0 ? "no request" : s.routes.join(", ")}`;
