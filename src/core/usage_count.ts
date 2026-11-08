/**
 * Usage counts: requests by the hour, counted in memory and written in bulk.
 *
 * `count` is one map increment and runs no query. `flush` writes every
 * pending key in one transaction as an upsert that adds to `n`. It runs by
 * itself about a second after the first pending count, once 500 keys are
 * pending (deferred, never inside `count`) and on `stop()`. The timer is
 * `unref`'d so it never holds a process or a test open.
 *
 * A failed write loses nothing: the counts go back and the timer retries.
 * Only an explicit `flush()` or `stop()` sees the error; the timer swallows it.
 * `count` throws RangeError on a malformed event (a programming error), so a
 * caller on the request path must wrap it in try/catch.
 */

import type { Database } from "bun:sqlite";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "./write_clock.ts";

export const ROLES = ["anon", "user", "admin", "agent", "crawler"] as const;
export const SURFACES = ["api", "mcp", "web"] as const;
export const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "OTHER",
] as const;

export type UsageRole = (typeof ROLES)[number];
export type UsageSurface = (typeof SURFACES)[number];

export interface UsageEvent {
  readonly pattern: string;
  readonly method: string;
  readonly status: number;
  readonly role: string;
  readonly surface: string;
}

export interface UsageRow {
  readonly hour: string;
  readonly pattern: string;
  readonly method: string;
  readonly status: string;
  readonly role: string;
  readonly surface: string;
  readonly n: number;
}

export interface UsageCounter {
  count(event: UsageEvent): void;
  flush(): void;
  stop(): void;
}

const FLUSH_MS = 1000;
const FLUSH_KEYS = 500;
const MAX_PATTERN = 200;
const SEP = "\u0000";

/** `2026-10-16T13`: the hour a moment falls in, UTC. */
export function hourOf(at: Date): string {
  return at.toISOString().slice(0, 13);
}

function refuse(event: UsageEvent): string | null {
  if (!(ROLES as readonly string[]).includes(event.role)) return "role";
  if (!(SURFACES as readonly string[]).includes(event.surface))
    return "surface";
  if (!(METHODS as readonly string[]).includes(event.method)) return "method";
  if (
    !Number.isInteger(event.status) ||
    event.status < 200 ||
    event.status > 599
  )
    return "status";
  if (
    typeof event.pattern !== "string" ||
    event.pattern.length === 0 ||
    event.pattern.length > MAX_PATTERN
  )
    return "pattern";
  return null;
}

export function createUsageCounter(
  db: Database,
  now: () => Date = () => new Date(),
  flushMs: number = FLUSH_MS,
): UsageCounter {
  const pending = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay: number): void {
    clear();
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // flush already put the counts back and rearmed the retry.
      }
    }, delay);
    timer.unref();
  }

  function flush(): void {
    clear();
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    try {
      const upsert = db.query(
        `INSERT INTO usage_count (hour, pattern, method, status, role, surface, n)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (hour, pattern, method, status, role, surface)
         DO UPDATE SET n = n + excluded.n`,
      );
      // Behind another process's lock this throws at once and the counts go back (#6957).
      withoutWaiting(db, db.transaction(() => quietly(db, () => {
        for (const [key, n] of batch) {
          const [hour, pattern, method, status, role, surface] = key.split(
            SEP,
          ) as [string, string, string, string, string, string];
          upsert.run(hour, pattern, method, status, role, surface, n);
        }
      })));
    } catch (err) {
      // Put the counts back so a failed write loses nothing.
      for (const [key, n] of batch)
        pending.set(key, (pending.get(key) ?? 0) + n);
      if (!stopped) schedule(Math.max(flushMs, 1));
      throw err;
    }
  }

  function count(event: UsageEvent): void {
    const bad = refuse(event);
    if (bad) throw new RangeError(`usage count refused: bad ${bad}`);
    if (stopped) return;
    const key = [
      hourOf(now()),
      event.pattern,
      event.method,
      `${Math.floor(event.status / 100)}xx`,
      event.role,
      event.surface,
    ].join(SEP);
    pending.set(key, (pending.get(key) ?? 0) + 1);
    if (pending.size >= FLUSH_KEYS) schedule(0);
    else if (timer === null) schedule(flushMs);
  }

  function stop(): void {
    stopped = true;
    flush();
  }

  return { count, flush, stop };
}

/** Every row from `sinceHour` (`2026-10-16T13`) on, oldest hour first. */
export function readUsage(db: Database, sinceHour: string): UsageRow[] {
  return db
    .query(
      `SELECT hour, pattern, method, status, role, surface, n FROM usage_count
       WHERE hour >= ?1 ORDER BY hour, pattern, method, status, role, surface`,
    )
    .all(sinceHour) as UsageRow[];
}
