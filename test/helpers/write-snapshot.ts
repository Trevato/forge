/**
 * What a database holds, read so that two reads around a run of refused
 * writes can be compared (#9031). Every table is held to its row count,
 * except the two counters a timer flushes on its own (`route_timing`,
 * `usage_count`): there the `/mcp` rows, which count the test's own
 * requests, are left out of the snapshot and summed by `ownCount` instead,
 * and every other row is held exactly, in primary-key order.
 *
 * Why the exact rows cannot flake: a row only appears in these tables for a
 * request the server answered, keyed by its route pattern. A server that
 * only ever answers `POST /mcp` has nothing pending under any other pattern,
 * so a flush between two reads touches `/mcp` rows alone; an hour turning
 * over adds a new `/mcp` row, which is also left out; and the 30-day prune
 * finds nothing in a database made minutes ago.
 */
import type { Database } from "bun:sqlite";

/** The pattern the router files every MCP call under (`mcpRoutes` in src/http/mcp.ts). */
export const MCP_PATTERN = "/mcp";

/** Each timer-flushed counter, with its primary key in order (see its migration). */
export const COUNTERS: Record<string, readonly string[]> = {
  route_timing: ["hour", "pattern", "bucket"],
  usage_count: ["hour", "pattern", "method", "status", "role", "surface"],
};

export type Snapshot = Record<string, number | unknown[]>;

export function snapshot(db: Database): Snapshot {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  return Object.fromEntries(
    tables.map((n) => {
      const key = COUNTERS[n];
      return [
        n,
        key
          ? db
              .query(`SELECT * FROM "${n}" WHERE pattern IS NOT ?1 ORDER BY ${key.join(", ")}`)
              .all(MCP_PATTERN)
          : db.query<{ c: number }, []>(`SELECT count(*) AS c FROM "${n}"`).get()!.c,
      ];
    }),
  );
}

/** Total counted under `/mcp` across the counters: it may rise, never fall. */
export function ownCount(db: Database): number {
  let sum = 0;
  for (const n of Object.keys(COUNTERS)) {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
      .get(n);
    if (!exists) continue;
    sum += db
      .query<{ t: number }, [string]>(`SELECT coalesce(sum(n), 0) AS t FROM "${n}" WHERE pattern = ?1`)
      .get(MCP_PATTERN)!.t;
  }
  return sum;
}
