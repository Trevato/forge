/**
 * What a forge holds, counted: the same five numbers when a snapshot is
 * taken (kept in its manifest) and when the drill restores it, so the two
 * can be set side by side. Plain data out.
 */

import type { Database } from "bun:sqlite";

export interface DrillCounts {
  readonly repositories: number;
  readonly issues: number;
  readonly users: number;
  readonly pulls: number;
  readonly apps: number;
}

export function countRows(db: Database): DrillCounts {
  const n = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    repositories: n("SELECT count(*) AS n FROM repo"),
    issues: n("SELECT count(*) AS n FROM issue"),
    users: n("SELECT count(*) AS n FROM user"),
    pulls: n("SELECT count(*) AS n FROM pull"),
    apps: n("SELECT count(*) AS n FROM app"),
  };
}

/** The names of the counts that differ, empty when they all match. */
export function mismatched(kept: DrillCounts, found: DrillCounts): string[] {
  return (Object.keys(kept) as (keyof DrillCounts)[]).filter((k) => kept[k] !== found[k]);
}
