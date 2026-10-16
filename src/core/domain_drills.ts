/** Every domain drill's result, kept with its verdict (`kernel/domain_drill.ts`). */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import type { Observed, Verdict } from "../kernel/domain_drill.ts";

export interface DrillRecord extends Verdict {
  readonly id: string;
  readonly domain: string;
  readonly backSeconds: number;
}

export function recordDrill(
  db: Database,
  by: string,
  domain: string,
  seen: Observed,
  backSeconds: number,
  verdict: Verdict,
): DrillRecord {
  const row = id();
  db.query(
    `INSERT INTO domain_drill (id, domain, run_by, health, board, back_seconds, green, why)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).run(row, domain, by, seen.health, seen.board, backSeconds, verdict.green ? 1 : 0, verdict.why);
  return { id: row, domain, backSeconds, ...verdict };
}

export interface LastDrill {
  readonly green: boolean;
  readonly why: string;
  readonly backSeconds: number;
  readonly at: string;
}

/** The newest drill kept for a domain, or null when none has run. */
export function lastDrill(db: Database, domain: string): LastDrill | null {
  const r = db
    .query<{ green: number; why: string; back_seconds: number; at: string }, [string]>(
      `SELECT green, why, back_seconds, at FROM domain_drill
       WHERE domain = ?1 ORDER BY at DESC, rowid DESC LIMIT 1`,
    )
    .get(domain);
  return r === null ? null : { green: r.green === 1, why: r.why, backSeconds: r.back_seconds, at: r.at };
}
