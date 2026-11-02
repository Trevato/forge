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
import { statements } from "./statements.ts";

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
