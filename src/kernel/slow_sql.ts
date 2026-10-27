/**
 * Statements that hold the thread (#6957). bun:sqlite is synchronous: a
 * statement waiting on another process's write lock (`busy_timeout`, 15 s)
 * or walking a big table stops every request, `/healthz` too, for as long
 * as it takes. `timeStatements` wraps one handle so a statement or exec
 * that takes `overMs` or more is one warning with the first words of its
 * SQL and the stack that called it: the stall names itself.
 *
 * SQL text is the code's own (values are bound, never spliced in), and the
 * log redacts anything credential-shaped besides. At most `PER_MINUTE`
 * lines a minute, so a lock held for minutes is a few lines, not thousands.
 */

import type { Database } from "bun:sqlite";
import type { Log } from "./log.ts";

/** A statement this slow is a stall a person waits through. */
export const SLOW_SQL_MS = 200;
const PER_MINUTE = 10;
const METHODS = ["run", "get", "all", "values"] as const;

/** The SQL's first 100 characters on one line. */
export function sqlHead(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim().slice(0, 100);
}

/** The callers above this module, nearest first, on one line. */
function callers(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter((l) => l !== "" && !l.includes("slow_sql.ts"))
    .slice(0, 6)
    .join(" < ");
}

/** Wrap `db`'s query, prepare, run and exec; `now` is a clock in ms. */
export function timeStatements(
  db: Database,
  log: Pick<Log, "warn">,
  overMs = SLOW_SQL_MS,
  now: () => number = () => performance.now(),
): void {
  let minute = 0;
  let told = 0;
  const report = (sql: unknown, ms: number): void => {
    const at = Math.floor(Date.now() / 60_000);
    if (at !== minute) [minute, told] = [at, 0];
    if (++told > PER_MINUTE) return;
    log.warn("slow statement held the thread", { ms: Math.round(ms), sql: sqlHead(sql), stack: callers() });
  };
  const timed = <A extends unknown[], R>(sql: unknown, fn: (...args: A) => R) =>
    (...args: A): R => {
      const start = now();
      try {
        return fn(...args);
      } finally {
        const ms = now() - start;
        if (ms >= overMs) report(sql, ms);
      }
    };
  const wrapped = new WeakSet<object>();
  const wrap = <S extends object>(stmt: S, sql: unknown): S => {
    if (wrapped.has(stmt)) return stmt;
    wrapped.add(stmt);
    const methods = stmt as unknown as Record<string, unknown>;
    for (const m of METHODS) {
      const fn = methods[m];
      if (typeof fn === "function") methods[m] = timed(sql, (fn as (...a: unknown[]) => unknown).bind(stmt));
    }
    return stmt;
  };
  const handle = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["query", "prepare"] as const) {
    const make = handle[name]!.bind(db);
    handle[name] = (sql: unknown, ...rest: unknown[]) => wrap(make(sql, ...rest) as object, sql);
  }
  for (const name of ["run", "exec"] as const) {
    const exec = handle[name]!.bind(db);
    handle[name] = (sql: unknown, ...rest: unknown[]) => timed(sql, exec)(sql, ...rest);
  }
}
