/**
 * What an issue will cost, as a range, from what past issues of its size and
 * kind cost (#8704). Measured, never guessed, and no agent run is spent: the
 * history is the ledger of finished work. Same history, same range. Plain data
 * in and out; `issueHistory` is the one read.
 */

import type { Database } from "bun:sqlite";
import type { Issue } from "../core/issues.ts";

/** Samples a group needs before it may speak; fewer and the estimate says so. */
export const MIN_SAMPLES = 3;
/** Samples at which a group is trusted. */
export const SURE_SAMPLES = 8;
/** The most past issues one estimate reads. */
const HISTORY_MAX = 400;

export type Size = "small" | "medium" | "large";

export interface Sample {
  readonly size: Size;
  readonly kind: string;
  readonly usd: number;
}

export type Estimate =
  | { readonly known: true; readonly low: number; readonly mid: number; readonly high: number; readonly samples: number; readonly basis: string }
  | { readonly known: false; readonly samples: number; readonly basis: string };

/** How big an issue reads, from the words written on it. */
export function sizeOf(issue: Pick<Issue, "title" | "body">): Size {
  const n = issue.title.length + issue.body.length;
  return n < 400 ? "small" : n < 1500 ? "medium" : "large";
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.round((sorted.length - 1) * q)]!;
const cents = (n: number): number => Math.round(n * 100) / 100;

function rangeOf(group: readonly Sample[], basis: string): Estimate {
  const usd = group.map((s) => s.usd).sort((a, b) => a - b);
  return {
    known: true,
    low: cents(quantile(usd, 0.25)),
    mid: cents(quantile(usd, 0.5)),
    high: cents(quantile(usd, 0.75)),
    samples: usd.length,
    basis,
  };
}

/** Past issues of the same size and kind; if too few, of the same size; if still too few, no estimate. */
export function estimate(history: readonly Sample[], size: Size, kind: string): Estimate {
  const same = history.filter((s) => s.size === size && s.kind === kind);
  if (same.length >= MIN_SAMPLES) return rangeOf(same, `${same.length} past ${size} ${kind === "" ? "issues" : `“${kind}” issues`}`);
  const sized = history.filter((s) => s.size === size);
  if (sized.length >= MIN_SAMPLES) return rangeOf(sized, `${sized.length} past ${size} issues`);
  return { known: false, samples: sized.length, basis: `too little history: ${sized.length} past ${size} issues` };
}

/** The kind of an issue: its first label by name, lowercase, or "". */
export const kindOf = (labels: readonly string[]): string => [...labels].map((l) => l.toLowerCase()).sort()[0] ?? "";

/** Labels of the given issues, by issue id (the issue_label key leads with the issue). */
export function labelsOf(db: Database, issueIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let at = 0; at < issueIds.length; at += 200) {
    const part = issueIds.slice(at, at + 200);
    const rows = db
      .query<{ issue_id: string; name: string }, string[]>(
        `SELECT il.issue_id, l.name FROM issue_label il JOIN label l ON l.id = il.label_id
          WHERE il.issue_id IN (${part.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .all(...part);
    for (const r of rows) out.set(r.issue_id, [...(out.get(r.issue_id) ?? []), r.name]);
  }
  return out;
}

/** What closed issues cost: every agent run on each, summed; the latest {@link HISTORY_MAX} by number. */
export function issueHistory(db: Database, repoId: string): Sample[] {
  const rows = db
    .query<{ id: string; title: string; body: string; usd: number }, [string, number]>(
      `SELECT i.id, i.title, i.body,
              (SELECT SUM(r.cost_usd) FROM run r WHERE r.issue_id = i.id AND r.kind = 'agent') AS usd
         FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'closed' AND i.sealed = 0 AND i.close_reason = 'done' AND usd > 0
        ORDER BY i.number DESC LIMIT ?2`,
    )
    .all(repoId, HISTORY_MAX);
  const labels = labelsOf(db, rows.map((r) => r.id));
  return rows.map((r) => ({ size: sizeOf(r), kind: kindOf(labels.get(r.id) ?? []), usd: r.usd }));
}
