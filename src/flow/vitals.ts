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
import { readChecksPile } from "./checks_pile.ts";
import { readOldestApproved } from "./oldest_approved.ts";
import { readStranded } from "./stranded.ts";

const HOUR_MS = 3_600_000;

export const OPEN_TARGET = 40;
export const CONFLICTED_TARGET = 5;
/** A clog is declared when the oldest approved pull has waited past this (#6422). */
export const APPROVED_WAIT_HOURS = 24;

export interface Vitals {
  readonly open: number;
  readonly opened1h: number;
  readonly landed1h: number;
  readonly opened6h: number;
  readonly landed6h: number;
  readonly conflicted: number;
  /** Open pulls whose latest check is red. */
  readonly red: number;
  /** Open pulls with a check queued for a slot. */
  readonly queued: number;
  /** Hours the longest-waiting approved pull has waited; null when none is. */
  readonly oldestApprovedHours: number | null;
  /** Dollars of crew runs on open, unlanded pulls. */
  readonly strandedUsd: number;
}

/** What a reader is shown: `strandedUsd` is left out for a reader without telemetry:read. */
export type ShownVitals = Omit<Vitals, "strandedUsd"> & { readonly strandedUsd?: number };

/** `v` as a reader may see it: dollars only when `spend` (the owner, or an agent holding telemetry:read). */
export function vitalsFor(v: Vitals, spend: boolean): ShownVitals {
  if (spend) return v;
  const { strandedUsd: _spend, ...rest } = v;
  return rest;
}

/** `publicOnly` counts public repositories alone, for a reader who must not learn what private ones hold. */
export function readVitals(db: Database, now = new Date(), publicOnly = false): Vitals {
  const to = now.toISOString();
  const h1 = new Date(now.getTime() - HOUR_MS).toISOString();
  const h6 = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
  const row = db
    .query<Omit<Vitals, "conflicted" | "red" | "queued" | "oldestApprovedHours" | "strandedUsd">, [string, string, string, number]>(
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
  const pile = readChecksPile(db, publicOnly);
  return {
    open: row?.open ?? 0,
    opened1h: row?.opened1h ?? 0,
    landed1h: row?.landed1h ?? 0,
    opened6h: row?.opened6h ?? 0,
    landed6h: row?.landed6h ?? 0,
    conflicted: conflictedPulls(db, publicOnly).length,
    red: pile.red,
    queued: pile.queued,
    oldestApprovedHours: readOldestApproved(db, now, publicOnly)?.hours ?? null,
    strandedUsd: readStranded(db, publicOnly).usd,
  };
}

/** Which targets the reading misses, in words; empty when it meets them all. */
export function vitalsMisses(v: ShownVitals): string[] {
  const out: string[] = [];
  if (v.open >= OPEN_TARGET) out.push(`open ${v.open} ≥ ${OPEN_TARGET}`);
  if (v.conflicted >= CONFLICTED_TARGET) out.push(`conflicted ${v.conflicted} ≥ ${CONFLICTED_TARGET}`);
  if (v.landed6h < v.opened6h) out.push(`landed ${v.landed6h} < opened ${v.opened6h} over 6 h`);
  if (v.oldestApprovedHours !== null && v.oldestApprovedHours > APPROVED_WAIT_HOURS)
    out.push(`oldest approved pull has waited ${Math.floor(v.oldestApprovedHours)} h`);
  return out;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The new numbers, in the order both lines say them; each part is left out when it has nothing to say. */
function extras(v: ShownVitals): { red: string; oldest: string | null; stranded: string | null } {
  return {
    red: `${v.red} red, ${v.queued} queued`,
    oldest: v.oldestApprovedHours === null ? null : `oldest approved ${Math.floor(v.oldestApprovedHours)} h`,
    stranded: v.strandedUsd === undefined ? null : `${usd(v.strandedUsd)} stranded`,
  };
}

/** The tick line's one value: `open 12, opened/landed 3/2 in 1 h, 9/11 in 6 h, conflicted 1, red 0, queued 0, oldest approved 30 h, stranded $1.20`. */
export function vitalsWords(v: ShownVitals): string {
  const x = extras(v);
  return `open ${v.open}, opened/landed ${v.opened1h}/${v.landed1h} in 1 h, ${v.opened6h}/${v.landed6h} in 6 h, conflicted ${v.conflicted}, ${[x.red, x.oldest, x.stranded].filter((w) => w !== null).join(", ")}`;
}

/** Home's line for an admin; the counts are the whole of it. */
export function vitalsLine(v: ShownVitals): string {
  const x = extras(v);
  return `${v.open} open pulls · ${v.opened1h} opened, ${v.landed1h} landed in 1 h · ${v.opened6h} opened, ${v.landed6h} landed in 6 h · ${v.conflicted} conflicted · ${[x.red, x.oldest, x.stranded].filter((w) => w !== null).join(" · ")}`;
}
