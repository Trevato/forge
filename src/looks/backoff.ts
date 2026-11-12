/**
 * The wait between tries of a look whose picture failed (#11509). A page
 * that gives no picture is tried again after each step of a backoff, then
 * given up: an app that is not answering must not have a browser opened
 * on it every second.
 *
 * Plain state behind a clock the caller hands in, so a test can move time
 * and fire the retries itself.
 */

/** Time, and a way to run something later: the real ones unless a test says otherwise. */
export interface BackoffClock {
  now(): number;
  /** Runs `fn` after `ms`; the function returned cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: BackoffClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** What a failure comes to: another try after `waitMs`, or the last one. */
export type Failed =
  | { readonly retry: true; readonly tries: number; readonly waitMs: number }
  | { readonly retry: false; readonly tries: number };

export interface Backoff {
  /** Whether a try for this key now would be early: it is waiting out a step, or given up. */
  waiting(key: string): boolean;
  /** A try failed: `again` runs after the next step, unless it was the last. */
  failed(key: string, again: () => void): Failed;
  /** A try succeeded: the key starts afresh. */
  succeeded(key: string): void;
  /** Every key under this prefix is dropped, its retry with it. */
  forget(prefix: string): void;
  /** Every retry waiting is cancelled. */
  stop(): void;
  /** How many keys are held (bounded by `max`). */
  readonly size: number;
}

interface Entry {
  readonly tries: number;
  readonly until: number;
  readonly cancel: (() => void) | undefined;
}

/**
 * A backoff over `steps` milliseconds. At most `max` keys are held; past
 * that the oldest failure is dropped (its retry cancelled), never the
 * whole table — under load the rest keep their waits.
 */
export function backoff(
  steps: readonly number[],
  clock: BackoffClock = realClock,
  max = 500,
): Backoff {
  // A Map keeps insertion order: a key re-set is moved to the end, so the
  // first key is always the one that failed longest ago.
  const entries = new Map<string, Entry>();

  const drop = (key: string): void => {
    entries.get(key)?.cancel?.();
    entries.delete(key);
  };

  return {
    waiting(key) {
      const entry = entries.get(key);
      return entry !== undefined && entry.until > clock.now();
    },
    failed(key, again) {
      const tries = (entries.get(key)?.tries ?? 0) + 1;
      drop(key);
      const waitMs = steps[tries - 1];
      if (waitMs === undefined) {
        entries.set(key, { tries, until: Infinity, cancel: undefined });
      } else {
        const cancel = clock.after(waitMs, () => {
          const entry = entries.get(key);
          if (entry === undefined || entry.tries !== tries) return;
          // The wait is over: the next try is due, the count kept.
          entries.set(key, { ...entry, until: 0, cancel: undefined });
          again();
        });
        entries.set(key, { tries, until: clock.now() + waitMs, cancel });
      }
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      return waitMs === undefined
        ? { retry: false, tries }
        : { retry: true, tries, waitMs };
    },
    succeeded(key) {
      drop(key);
    },
    forget(prefix) {
      for (const key of [...entries.keys()])
        if (key.startsWith(prefix)) drop(key);
    },
    stop() {
      for (const entry of entries.values()) entry.cancel?.();
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
