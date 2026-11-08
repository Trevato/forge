/**
 * Efficiency — what an app's crew spent per change it shipped, over a
 * window: the forge's efficiency signal. Spend is the usage ledger's
 * (`core/usage.ts`), so it counts every agent run that ended in the window,
 * shipped or not; a shipped change is a pull merged in the window.
 *
 * Units: US dollars of the provider's list-price equivalent
 * (`usage.cost_usd`), rounded to 1/10 000 of a dollar.
 *
 *   perShippedUsd = Σ usage.cost_usd (at ≥ since) ÷ count(merged_at ≥ since)
 *
 * and null when nothing shipped — a ratio over zero changes is not a
 * number, and "all of it" is said in words by the page, not as infinity.
 *
 * Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";

export interface Efficiency {
  readonly repoId: string;
  /** Ledger lines (agent runs) that ended in the window. */
  readonly runs: number;
  readonly spentUsd: number;
  /** Pulls merged in the window. */
  readonly shipped: number;
  /** spentUsd ÷ shipped; null when nothing shipped. */
  readonly perShippedUsd: number | null;
}

const money = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Each repository's spend and shipped changes since an instant, in one
 * grouped query. A repository with neither is absent: a quiet app is no
 * row, not a row of zeros.
 */
export function efficiencyForRepos(
  db: Database,
  repoIds: readonly string[],
  since: string,
): Map<string, Efficiency> {
  const ids = [...new Set(repoIds)].slice(0, 400);
  const out = new Map<string, Efficiency>();
  if (ids.length === 0) return out;
  const list = ids.map((_, n) => `?${n + 2}`).join(",");
  const rows = db
    .query<
      { repo_id: string; runs: number; spent: number; shipped: number },
      string[]
    >(
      `SELECT repo_id, SUM(runs) AS runs, SUM(spent) AS spent, SUM(shipped) AS shipped
         FROM (
           SELECT repo_id, COUNT(*) AS runs, SUM(cost_usd) AS spent, 0 AS shipped
             FROM usage
            WHERE at >= ?1 AND repo_id IN (${list})
            GROUP BY repo_id
           UNION ALL
           SELECT issue.repo_id, 0, 0, COUNT(*)
             FROM issue JOIN pull ON pull.issue_id = issue.id
            WHERE pull.merged_at IS NOT NULL AND pull.merged_at >= ?1
              AND issue.repo_id IN (${list})
            GROUP BY issue.repo_id
         )
        GROUP BY repo_id`,
    )
    .all(since, ...ids);
  for (const r of rows) {
    const spentUsd = money(r.spent);
    out.set(r.repo_id, {
      repoId: r.repo_id,
      runs: r.runs,
      spentUsd,
      shipped: r.shipped,
      perShippedUsd: r.shipped > 0 ? money(r.spent / r.shipped) : null,
    });
  }
  return out;
}

/** An app's spend per shipped change in a few words:
 * `$1.37 per shipped change`, or what is true when there is no ratio. */
export function perShippedWords(e: Efficiency | undefined): string {
  const dollars = (n: number): string => `$${n.toFixed(2)}`;
  if (e === undefined || (e.spentUsd === 0 && e.shipped === 0))
    return "nothing spent or shipped";
  if (e.perShippedUsd === null)
    return `${dollars(e.spentUsd)} spent, nothing shipped`;
  return `${dollars(e.perShippedUsd)} per shipped change`;
}
