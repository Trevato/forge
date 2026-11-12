/**
 * Read-only SQL against one source: `SELECT` or `WITH`, a read-only
 * connection, a time cap (the worker is ended, which stops even a query
 * that never yields) and a row cap.
 */

import { checkQuery } from "./sql.ts";
import type { Source } from "./sources.ts";

export const QUERY_TIMEOUT_MS = 5000;
export const QUERY_ROW_CAP = 1000;
/** Characters of result kept (a quarter megabyte). */
export const QUERY_BYTE_CAP = 250_000;
/** Memory a query may use. */
export const QUERY_HEAP = 128 * 1024 * 1024;
/** Queries running at once; one more is told the forge is busy. */
export const QUERY_WORKERS = 2;
let running = 0;

export type QueryResult =
  | {
      readonly ok: true;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly (string | number | null)[])[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly error: "empty" | "not_select" | "multiple" | "schema" | "timeout" | "sql" | "busy";
      readonly message: string;
    };

const REFUSALS = {
  empty: "Write a query.",
  not_select: "Only SELECT and WITH statements are allowed.",
  multiple: "One statement at a time.",
  schema: "Name tables without a schema prefix.",
} as const;

/** Queries running now (for tests). */
export const queriesRunning = (): number => running;

export function query(
  source: Source,
  sql: string,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<QueryResult> {
  const verdict = checkQuery(sql);
  if (verdict !== "ok")
    return Promise.resolve({ ok: false, error: verdict, message: REFUSALS[verdict] });
  if (running >= QUERY_WORKERS)
    return Promise.resolve({
      ok: false,
      error: "busy",
      message: "Busy with other queries: try again in a moment.",
    });
  running++;
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./query_worker.ts", import.meta.url).href);
    let finished = false;
    const done = (r: QueryResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      running--;
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        done({
          ok: false,
          error: "timeout",
          message: `Stopped after ${timeoutMs / 1000} s.`,
        }),
      timeoutMs,
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      done(
        m.ok
          ? { ok: true, columns: m.columns, rows: m.rows, truncated: m.truncated }
          : { ok: false, error: "sql", message: String(m.message) },
      );
    };
    worker.onerror = (e) =>
      done({ ok: false, error: "sql", message: e.message || "query failed" });
    worker.postMessage({
      path: source.path,
      sourceId: source.id,
      sql,
      limit: QUERY_ROW_CAP,
      bytes: QUERY_BYTE_CAP,
      heap: QUERY_HEAP,
    });
  });
}
