/**
 * Read-only SQL against one source: `SELECT` or `WITH`, a read-only
 * connection in a process of its own, a time cap (the process is ended, which stops even a query
 * that never yields), a heap limit that is the process's alone and a row cap.
 */

import { checkQuery } from "./sql.ts";
import type { Source } from "./sources.ts";

export const QUERY_TIMEOUT_MS = 5000;
export const QUERY_ROW_CAP = 1000;
/** Characters of result kept (a quarter megabyte). */
export const QUERY_BYTE_CAP = 250_000;
/** Memory a query may use, set by its own process (`query_child.ts`), never by the forge's. */
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
    const child = Bun.spawn([process.execPath, new URL("./query_child.ts", import.meta.url).pathname], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {},
    });
    let finished = false;
    const done = (r: QueryResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
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
    child.stdin.write(
      JSON.stringify({
        path: source.path,
        sourceId: source.id,
        sql,
        limit: QUERY_ROW_CAP,
        bytes: QUERY_BYTE_CAP,
        heap: QUERY_HEAP,
      }),
    );
    void child.stdin.end();
    void new Response(child.stdout).text().then(
      (text) => {
        try {
          const m = JSON.parse(text) as { ok: boolean; columns?: string[]; rows?: (string | number | null)[][]; truncated?: boolean; message?: string };
          done(
            m.ok
              ? { ok: true, columns: m.columns ?? [], rows: m.rows ?? [], truncated: m.truncated === true }
              : { ok: false, error: "sql", message: String(m.message) },
          );
        } catch {
          // The child died before it answered (a heap limit takes the process's allocator with it): the query failed.
          done({ ok: false, error: "sql", message: "The query used too much memory or stopped." });
        }
      },
      () => done({ ok: false, error: "sql", message: "query failed" }),
    );
  });
}
