/**
 * Runs one query off the main thread so that a slow one can be stopped by
 * ending the thread. Secret columns are shadowed by temporary views that
 * show the mask, so an alias or a subquery cannot read them.
 */

import { Database } from "bun:sqlite";
import { CELL_CAP, cell, maskPlan, MASK } from "./mask.ts";

declare const self: Worker;

interface Job {
  readonly path: string;
  readonly sourceId: string;
  readonly sql: string;
  readonly limit: number;
  /** Bytes of result text kept before the rest is dropped. */
  readonly bytes: number;
  /** Memory SQLite may hold for this query. */
  readonly heap: number;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

self.onmessage = (event: MessageEvent<Job>) => {
  const job = event.data;
  let db: Database | undefined;
  try {
    db = new Database(job.path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    for (const [name, hide] of maskPlan(db, job.sourceId)) {
      if (hide.size === 0) continue;
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(${quote(name)})`)
        .all();
      const select = cols
        .map((c) =>
          hide.has(c.name)
            ? `CASE WHEN main.${quote(name)}.${quote(c.name)} IS NULL THEN NULL ELSE '${MASK}' END AS ${quote(c.name)}`
            : `main.${quote(name)}.${quote(c.name)} AS ${quote(c.name)}`,
        )
        .join(", ");
      db.exec(`CREATE TEMP VIEW ${quote(name)} AS SELECT ${select} FROM main.${quote(name)}`);
    }
    db.exec("PRAGMA query_only = 1");
    db.exec(`PRAGMA hard_heap_limit = ${Math.floor(job.heap)}`);
    const columns = db.query(job.sql).columnNames;
    // Cut every cell inside SQLite, so a giant blob or string never reaches
    // this thread whole.
    const names = columns.map((_, i) => `c${i}`);
    const shown = names
      .map(
        (n) =>
          `CASE typeof(${n}) WHEN 'blob' THEN '<blob ' || length(${n}) || ' bytes>' WHEN 'text' THEN substr(${n}, 1, ${CELL_CAP + 1}) ELSE ${n} END`,
      )
      .join(", ");
    const body = job.sql.trim().replace(/;+\s*$/, "");
    const stmt =
      columns.length === 0
        ? db.query(job.sql)
        : db.query(`WITH q(${names.join(", ")}) AS (\n${body}\n) SELECT ${shown} FROM q`);
    const out: (string | number | null)[][] = [];
    let truncated = false;
    let size = 0;
    for (const row of stmt.values() as unknown[][]) {
      const cells = row.map(cell);
      size += cells.reduce<number>((n, v) => n + (typeof v === "string" ? v.length : 8), 0);
      if (out.length >= job.limit || size > job.bytes) {
        truncated = true;
        break;
      }
      out.push(cells);
    }
    self.postMessage({ ok: true, columns, rows: out, truncated });
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db?.close();
  }
};
