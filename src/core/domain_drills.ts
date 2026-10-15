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
