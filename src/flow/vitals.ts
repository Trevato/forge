/**
 * The flow vitals (#5935): how many pulls are open, how many opened and
 * landed in the last hour and the last 6 h, and how many open pulls conflict
 * with their base. One reading, shared by home, the autonomy tick line and
 * the MCP `flow` tool, so the three say the same numbers.
 *
 * Targets from #5924: open < 40, conflicted < 5, landed >= opened over each
 * 6 h. Counts only, no repository named; forge-wide for the owner,
 * public repositories alone for an agent. "Conflicted" is the count `conflicted.ts` reads from the bring-up-to-date runs.
 */

import type { Database } from "bun:sqlite";
import { conflictedPulls } from "./conflicted.ts";

const HOUR_MS = 3_600_000;

export const OPEN_TARGET = 40;
export const CONFLICTED_TARGET = 5;

export interface Vitals {
  readonly open: number;
  readonly opened1h: number;
  readonly landed1h: number;
  readonly opened6h: number;
  readonly landed6h: number;
  readonly conflicted: number;
}

/** `publicOnly` counts public repositories alone, for a reader who must not learn what private ones hold. */
export function readVitals(db: Database, now = new Date(), publicOnly = false): Vitals {
  const to = now.toISOString();
  const h1 = new Date(now.getTime() - HOUR_MS).toISOString();
  const h6 = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
  const row = db
    .query<Omit<Vitals, "conflicted">, [string, string, string, number]>(
      `SELECT
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE (?4 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL) AS open,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE (?4 = 0 OR r.visibility = 'public') AND i.created_at >= ?1 AND i.created_at <= ?3) AS opened1h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE (?4 = 0 OR r.visibility = 'public') AND i.created_at >= ?2 AND i.created_at <= ?3) AS opened6h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE (?4 = 0 OR r.visibility = 'public') AND p.base_branch = r.default_branch AND p.merged_at >= ?1 AND p.merged_at <= ?3) AS landed1h,
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
           WHERE (?4 = 0 OR r.visibility = 'public') AND p.base_branch = r.default_branch AND p.merged_at >= ?2 AND p.merged_at <= ?3) AS landed6h`,
    )
    .get(h1, h6, to, publicOnly ? 1 : 0);
  return {
    open: row?.open ?? 0,
    opened1h: row?.opened1h ?? 0,
    landed1h: row?.landed1h ?? 0,
    opened6h: row?.opened6h ?? 0,
    landed6h: row?.landed6h ?? 0,
    conflicted: conflictedPulls(db, publicOnly).length,
  };
}

/** Which targets the reading misses, in words; empty when it meets them all. */
export function vitalsMisses(v: Vitals): string[] {
  const out: string[] = [];
  if (v.open >= OPEN_TARGET) out.push(`open ${v.open} ≥ ${OPEN_TARGET}`);
  if (v.conflicted >= CONFLICTED_TARGET) out.push(`conflicted ${v.conflicted} ≥ ${CONFLICTED_TARGET}`);
  if (v.landed6h < v.opened6h) out.push(`landed ${v.landed6h} < opened ${v.opened6h} over 6 h`);
  return out;
}

/** The tick line's one value: `open 12, opened/landed 3/2 in 1 h, 9/11 in 6 h, conflicted 1`. */
export function vitalsWords(v: Vitals): string {
  return `open ${v.open}, opened/landed ${v.opened1h}/${v.landed1h} in 1 h, ${v.opened6h}/${v.landed6h} in 6 h, conflicted ${v.conflicted}`;
}

/** Home's line for an admin; the counts are the whole of it. */
export function vitalsLine(v: Vitals): string {
  return `${v.open} open pulls · ${v.opened1h} opened, ${v.landed1h} landed in 1 h · ${v.opened6h} opened, ${v.landed6h} landed in 6 h · ${v.conflicted} conflicted`;
}
