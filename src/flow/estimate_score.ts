/**
 * Scoring estimates (#11955). For each estimate resolved: ratio = actual duration /
 * p50 duration, both from the moment it was made. The median ratio is the bias
 * (2.4 means it runs 2.4× late: optimistic); the p90 hit rate is the share whose
 * actual instant was at or before the p90 (should be about 90%).
 *
 * One estimate counts per estimator, issue and event: the first one, so a revision
 * after the fact cannot improve a score (later ones are kept as data and shown, not scored).
 * The base rate shown at that moment is scored the same way as an estimator named
 * `history`. Void estimates are counted, never scored. Plain data in and out.
 */
import type { EstimateEvent, EstimateRow, EstimateState } from "../core/estimates.ts";
import { ratioOf, timesWords } from "./estimate_words.ts";

export const HISTORY = "history";
/** How many of an estimator's most recent resolved estimates the headline reads. */
export const LAST = 20;

export interface Scored {
  readonly who: string;
  readonly issueNumber: number;
  readonly event: EstimateEvent;
  readonly size: string;
  readonly kind: string;
  readonly madeAt: string;
  readonly p50At: string;
  readonly p90At: string;
  readonly actualAt: string | null;
  readonly state: EstimateState;
}

export interface Score {
  readonly who: string;
  /** "" for all of an estimator's work, else "small bug": a size and kind. */
  readonly group: string;
  readonly resolved: number;
  readonly void: number;
  readonly open: number;
  /** Median of actual/p50 over the resolved; null with none. */
  readonly medianRatio: number | null;
  /** Share of the resolved whose actual was at or before the p90, 0..1; null with none. */
  readonly p90Hit: number | null;
}

/** Median: the middle one, or the mean of the middle two. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The estimates that count: each estimator's first per issue and event, plus the history's first
 * per issue and event.
 */
export function scoredEstimates(rows: readonly EstimateRow[]): Scored[] {
  const seen = new Set<string>();
  const firstOfIssueEvent = new Set<string>();
  const out: Scored[] = [];
  const base = (r: EstimateRow, who: string, p50At: string, p90At: string): Scored => ({
    who, issueNumber: r.issueNumber, event: r.event, size: r.size, kind: r.kind, madeAt: r.madeAt, p50At, p90At, actualAt: r.actualAt, state: r.state,
  });
  for (const r of rows) {
    const key = `${r.issueId}/${r.event}`;
    if (!firstOfIssueEvent.has(key)) {
      firstOfIssueEvent.add(key);
      try {
        const b = JSON.parse(r.baseJson) as { events?: Record<string, { p50At?: string; p90At?: string } | null> } | null;
        const h = b?.events?.[r.event];
        if (typeof h?.p50At === "string" && typeof h.p90At === "string") out.push(base(r, HISTORY, h.p50At, h.p90At));
      } catch {
        // A base that does not read is not scored; the estimate still is.
      }
    }
    const mine = `${key}/${r.byName}`;
    if (seen.has(mine)) continue;
    seen.add(mine);
    out.push(base(r, r.byName, r.p50At, r.p90At));
  }
  return out;
}

const groupOf = (s: Pick<Scored, "size" | "kind">): string => (s.kind === "" ? s.size : `${s.size} ${s.kind}`);

function tally(who: string, group: string, rows: readonly Scored[], last?: number): Score {
  const resolved = rows
    .filter((s) => s.state === "resolved" && s.actualAt !== null)
    .sort((a, b) => (a.actualAt! < b.actualAt! ? -1 : a.actualAt! > b.actualAt! ? 1 : 0));
  const read = last === undefined ? resolved : resolved.slice(-last);
  const ratios = read.flatMap((s) => ratioOf(s) ?? []);
  const held = read.filter((s) => Date.parse(s.actualAt!) <= Date.parse(s.p90At)).length;
  return {
    who,
    group,
    resolved: resolved.length,
    void: rows.filter((s) => s.state === "void").length,
    open: rows.filter((s) => s.state === "open").length,
    medianRatio: median(ratios),
    p90Hit: read.length === 0 ? null : held / read.length,
  };
}

/**
 * One score per estimator over all its estimates, then one per size and kind, the estimators in
 * name order and `history` last.
 */
export function scoreboard(rows: readonly EstimateRow[], last?: number): Score[] {
  const scored = scoredEstimates(rows);
  const who = [...new Set(scored.map((s) => s.who))].sort((a, b) => (a === HISTORY ? 1 : b === HISTORY ? -1 : a < b ? -1 : 1));
  return who.flatMap((w) => {
    const mine = scored.filter((s) => s.who === w);
    const groups = [...new Set(mine.map(groupOf))].sort();
    return [tally(w, "", mine, last), ...groups.map((g) => tally(w, g, mine.filter((s) => groupOf(s) === g), last))];
  });
}

/**
 * "median 2.4× late, p90 held 55%": the bias and the p90 in words; undefined with nothing resolved.
 */
export function biasWords(s: Pick<Score, "medianRatio" | "p90Hit">): string | undefined {
  if (s.medianRatio === null || s.p90Hit === null) return undefined;
  const r = s.medianRatio;
  const bias = r >= 1.05 ? `${timesWords(r)} late` : r > 0 && r <= 1 / 1.05 ? `${timesWords(1 / r)} early` : "on the mark";
  return `median ${bias}, p90 held ${Math.round(s.p90Hit * 100)}%`;
}

/**
 * "your last 20: median 2.4× late, p90 held 55%" for one estimator; says so when nothing has
 * resolved yet.
 */
export function lastLine(rows: readonly EstimateRow[], who: string, you = false): string {
  const s = scoreboard(rows, LAST).find((x) => x.who === who && x.group === "");
  const words = s === undefined ? undefined : biasWords(s);
  const count = s === undefined ? 0 : Math.min(s.resolved, LAST);
  const head = `${you ? "your" : `${who}'s`} last ${count}`;
  return words === undefined ? `${you ? "you have" : `${who} has`} no resolved estimates yet` : `${head}: ${words}`;
}
