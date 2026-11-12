/**
 * The week is the sprint (#8704): the subscription's weekly reset is the
 * boundary and what the crew may still spend before it is the capacity. The
 * cut line falls on the owner's ranked list after the last issue whose
 * running estimate still fits, building strictly from the top, so reranking
 * moves it. Same list, same history, same capacity: same line. No agent run
 * is spent. `cutLine` is plain data in and out; `weekCapacity` is the one read.
 */

import type { Database } from "bun:sqlite";
import type { NextRow } from "../core/next_up.ts";
import { standings } from "../core/standing.ts";
import { listCredentials } from "../core/subscriptions.ts";
import { estimate, issueHistory, kindOf, labelsOf, MIN_SAMPLES, SURE_SAMPLES, sizeOf, type Estimate, type Sample } from "./estimate.ts";

export interface Capacity {
  /** What the crew may still spend before the reset, in US dollars. */
  readonly usd: number;
  /** The soonest weekly reset among the accounts that report one, ISO. */
  readonly resetsAt: string | null;
}

/** The crew's remaining weekly capacity over every account whose cap is known; null when none is. */
export function weekCapacity(db: Database, now: Date): Capacity | null {
  const ids = listCredentials(db).map((c) => c.id);
  let usd = 0;
  let resetsAt: string | null = null;
  let any = false;
  for (const s of standings(db, ids, now).values()) {
    const week = s.windows.find((w) => w.window === "week");
    if (week?.crewRemaining == null) continue;
    any = true;
    usd += week.crewRemaining.value;
    const at = week.resetsAt?.value ?? null;
    if (at !== null && (resetsAt === null || at < resetsAt)) resetsAt = at;
  }
  return any ? { usd: Math.round(usd * 100) / 100, resetsAt } : null;
}

export interface Priced {
  readonly number: number;
  readonly estimate: Estimate;
}

export type Confidence = "high" | "medium" | "low";

export interface Cut {
  /** Issue numbers that fit this week, in list order; the rest read as next week. */
  readonly fits: readonly number[];
  /** The least and most that should ship by the reset, from the range's two ends. */
  readonly shipLow: number;
  readonly shipHigh: number;
  readonly confidence: Confidence;
  /** Why there is no line: capacity or history missing. Null when drawn. */
  readonly unsure: string | null;
}

/** Walk the list from the top, adding each row's cost while it fits `usd`; stop at the first that does not. */
function fitting(rows: readonly Priced[], cost: (e: Estimate & { known: true }) => number, fill: number, usd: number): number[] {
  const out: number[] = [];
  let used = 0;
  for (const r of rows) {
    used += r.estimate.known ? cost(r.estimate) : fill;
    if (used > usd) break;
    out.push(r.number);
  }
  return out;
}

/** The client's half of the rule, as source: how many rows from the top fit `usd` (the page's drag re-places the line with it). */
export const FIT_COUNT_JS = `function fitCount(costs, usd) {
  let used = 0, n = 0;
  for (const c of costs) { used += c; if (used > usd) break; n++; }
  return n;
}`;

/** The cut line's two sentences, one place for the page and its script. */
export const CUT_TOP_WORDS = "Nothing here fits what is left of this week: all of this reads as next week.";
export const cutWords = (fit: number | string): string => `This week ends here (${fit} fit): below this line reads as next week.`;

/** What each row counts for against the week: its mid, or the median mid when it has no estimate; null when no line can be drawn. */
export function rowCosts(rows: readonly Priced[]): number[] | null {
  const known = rows.flatMap((r) => (r.estimate.known ? [r.estimate.mid] : []));
  if (known.length === 0) return null;
  const fill = known.sort((a, b) => a - b)[Math.floor((known.length - 1) / 2)]!;
  return rows.map((r) => (r.estimate.known ? r.estimate.mid : fill));
}

/**
 * Where the week's capacity ends on the ranked list. An issue with no
 * estimate counts as the median of those that have one; with none at all
 * there is no line, and it says so.
 */
export function cutLine(rows: readonly Priced[], capacity: Capacity | null): Cut {
  const none = (unsure: string): Cut => ({ fits: [], shipLow: 0, shipHigh: 0, confidence: "low", unsure });
  if (capacity === null) return none("the weekly capacity has not been read yet");
  const known = rows.flatMap((r) => (r.estimate.known ? [r.estimate] : []));
  if (known.length === 0) return none("there is too little history to estimate any issue");
  const mids = known.map((e) => e.mid).sort((a, b) => a - b);
  const fill = mids[Math.floor((mids.length - 1) / 2)]!;
  const fits = fitting(rows, (e) => e.mid, fill, capacity.usd);
  const least = fitting(rows, (e) => e.high, fill, capacity.usd).length;
  const most = fitting(rows, (e) => e.low, fill, capacity.usd).length;
  const weakest = Math.min(...rows.map((r) => r.estimate.samples));
  const confidence: Confidence =
    known.length < rows.length ? "low" : weakest >= SURE_SAMPLES ? "high" : weakest >= MIN_SAMPLES ? "medium" : "low";
  return { fits, shipLow: least, shipHigh: most, confidence, unsure: null };
}

/** The projection in one sentence. */
export function projection(cut: Cut, total: number, capacity: Capacity | null): string {
  if (cut.unsure !== null) return `No projection yet: ${cut.unsure}.`;
  const by = capacity?.resetsAt == null ? "the reset" : `the reset on ${capacity.resetsAt.slice(0, 10)}`;
  const count = cut.shipLow === cut.shipHigh ? `${cut.shipHigh}` : `${cut.shipLow} to ${cut.shipHigh}`;
  return `At the current rate ${count} of the ${total} issues on the list should ship by ${by}; ${cut.confidence} confidence.`;
}

/** Price each row of the list from the repository's history. */
export function priceRows(db: Database, repoId: string, rows: readonly NextRow[], history?: readonly Sample[]): Priced[] {
  const past = history ?? issueHistory(db, repoId);
  // The kind only narrows a history; with none there is nothing to narrow, so no read.
  const labels = past.length === 0 ? new Map<string, string[]>() : labelsOf(db, rows.map((r) => r.issue.id));
  return rows.map((r) => ({
    number: r.issue.number,
    estimate: estimate(past, sizeOf(r.issue), kindOf(labels.get(r.issue.id) ?? [])),
  }));
}

/** "$1.20–$3.40" or why there is none. */
export function rangeWords(e: Estimate): string {
  return e.known ? `$${e.low.toFixed(2)}–$${e.high.toFixed(2)} (${e.basis})` : e.basis;
}

/** Everything the page, the terminal and MCP draw of the week on Next up, from one read. */
export interface WeekView {
  readonly priced: readonly Priced[];
  readonly cut: Cut;
  readonly capacity: Capacity | null;
  readonly sentence: string;
}

export function weekView(db: Database, repoId: string, rows: readonly NextRow[], now: Date): WeekView {
  const capacity = weekCapacity(db, now);
  const priced = priceRows(db, repoId, rows);
  const cut = cutLine(priced, capacity);
  return { priced, cut, capacity, sentence: projection(cut, rows.length, capacity) };
}
