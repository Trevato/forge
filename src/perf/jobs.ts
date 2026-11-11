/**
 * Background jobs by name (#10834): a stall no request ran across is counted
 * against the timer, scheduler tick or sweep that was running (`loop.ts`).
 *
 * `during(name, fn)` marks `name` as blocking from the call until `fn`
 * returns: that synchronous slice is the only time it is sure to hold the
 * loop. When `fn` returns a promise, the job is then marked awaiting until
 * the promise settles; awaiting holds nothing, so an awaiting job is named
 * for a stall only when no job's synchronous slice ran across it — then one
 * of its continuations is the likeliest blocker, and the name is a lead, not
 * a verdict. Each call costs a map write and a ring slot or two. The clock
 * is `performance.now`, the stall watcher's.
 */

/** Finished slices kept to match a stall against: a tick a second fills it in about two minutes. */
const KEPT = 256;

export interface JobSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** True for the time after `fn` returned a promise and before it settled. */
  readonly awaiting: boolean;
}

export interface JobWatch {
  /** Run `fn` marked as job `name`; returns what it returns, and throws what it throws. */
  during<T>(name: string, fn: () => T): T;
  /**
   * The jobs whose synchronous slice ran across `[from, to]`, longest first,
   * each once; when there are none, the jobs awaiting across it.
   */
  across(from: number, to: number): string[];
}

export function createJobWatch(now: () => number = () => performance.now()): JobWatch {
  const awaiting = new Map<number, { name: string; start: number }>();
  const ring: (JobSpan | undefined)[] = new Array(KEPT);
  let next = 0;
  let id = 0;
  const keep = (span: JobSpan): void => {
    ring[next] = span;
    next = (next + 1) % KEPT;
  };
  const settle = (key: number): void => {
    const job = awaiting.get(key);
    if (job === undefined) return;
    awaiting.delete(key);
    keep({ name: job.name, start: job.start, end: now(), awaiting: true });
  };
  const names = (spans: JobSpan[]): string[] => [
    ...new Set(spans.sort((a, b) => b.end - b.start - (a.end - a.start)).map((s) => s.name)),
  ];
  return {
    during(name, fn) {
      const start = now();
      let result: ReturnType<typeof fn>;
      try {
        result = fn();
      } finally {
        keep({ name, start, end: now(), awaiting: false });
      }
      if (result instanceof Promise) {
        const key = ++id;
        awaiting.set(key, { name, start: now() });
        result.then(() => settle(key), () => settle(key));
      }
      return result;
    },
    across(from, to) {
      const overlapping = ring.filter(
        (s): s is JobSpan => s !== undefined && s.end >= from && s.start <= to,
      );
      const blocking = overlapping.filter((s) => !s.awaiting);
      if (blocking.length > 0) return names(blocking);
      const t = now();
      for (const r of awaiting.values())
        if (r.start <= to) overlapping.push({ name: r.name, start: r.start, end: t, awaiting: true });
      return names(overlapping);
    },
  };
}

/** The process's one job watch, read by the loop watch in `live.ts`. */
export const jobWatch = createJobWatch();
/** Run `fn` as background job `name` on the process's job watch. */
export const during = <T>(name: string, fn: () => T): T => jobWatch.during(name, fn);
