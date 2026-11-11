/**
 * What an issue cost (#1389): its own agent runs plus the runs of the pulls
 * whose description closes it (`closesFromBody`, the forge's one reading of
 * "closes"). US dollars, the provider's list price as the run recorded it
 * (`run.cost_usd`).
 *
 *   total = Σ cost of runs on the issue + Σ over closing pulls (Σ cost of runs on the pull)
 *
 * A pull that closes two issues counts in both, so the issues' totals may
 * add up to more than the forge spent; the repository's own total is the
 * usage ledger's. Sums are taken in 1/10 000 of a dollar to keep float
 * dust out of the line, as `core/efficiency.ts` does.
 *
 * Pure data: no authz. The caller has already decided the viewer may see
 * the issue.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "./pulls.ts";
import type { Repo } from "./repos.ts";
import { canSeeOwnerFacts } from "./repos.ts";
import { mayViewId } from "./sealed.ts";
import type { User } from "./users.ts";

export interface PullCost {
  readonly id: string;
  readonly number: number;
  readonly usd: number;
}

export interface IssueCost {
  /** Runs whose `issue_id` is the issue itself. */
  readonly ownUsd: number;
  /** Closing pulls (any state), oldest first, each with its own runs' cost. */
  readonly pulls: readonly PullCost[];
  /** `ownUsd` plus every pull. */
  readonly totalUsd: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function issueCost(db: Database, repoId: string, issueId: string, number: number): IssueCost {
  const sum = db.query<{ usd: number }, [string]>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM run WHERE issue_id = ?1",
  );
  const ownUsd = round4(sum.get(issueId)?.usd ?? 0);
  // The LIKE only narrows; `closesFromBody` decides.
  const candidates = db
    .query<{ id: string; number: number; body: string }, [string, string, string]>(
      `SELECT issue.id AS id, issue.number AS number, issue.body AS body
         FROM pull JOIN issue ON issue.id = pull.issue_id
        WHERE issue.repo_id = ?1 AND issue.id != ?2 AND issue.body LIKE ?3
        ORDER BY issue.number`,
    )
    .all(repoId, issueId, `%#${number}%`);
  const pulls: PullCost[] = [];
  for (const c of candidates) {
    if (!closesFromBody(c.body).includes(number)) continue;
    pulls.push({ id: c.id, number: c.number, usd: round4(sum.get(c.id)?.usd ?? 0) });
  }
  return { ownUsd, pulls, totalUsd: round4(ownUsd + pulls.reduce((s, p) => s + p.usd, 0)) };
}

/**
 * What this viewer may be told an issue cost: null when the cost is not
 * theirs to see (the issue is sealed from them, or they do not see the
 * owner's facts, as `runForReader` hides a run's cost from them) or when
 * nothing was spent. A closing pull sealed from them is left out of the sum.
 * The caller has already checked the viewer may read this repository's runs.
 */
export function issueCostFor(
  db: Database,
  repo: Repo,
  issue: { readonly id: string; readonly number: number },
  viewer: User | undefined,
): IssueCost | null {
  if (!canSeeOwnerFacts(db, repo, viewer) || !mayViewId(db, repo, issue.id, viewer)) return null;
  const all = issueCost(db, repo.id, issue.id, issue.number);
  const pulls = all.pulls.filter((p) => mayViewId(db, repo, p.id, viewer));
  const totalUsd = round4(all.ownUsd + pulls.reduce((s, p) => s + p.usd, 0));
  return totalUsd === 0 ? null : { ownUsd: all.ownUsd, pulls, totalUsd };
}

const usd2 = (n: number): string => `$${n.toFixed(2)}`;

/** The cost in one plain line, for the terminal: "Cost $0.75: this issue $0.50, #12 $0.25". */
export function costLine(cost: IssueCost): string {
  const spent = cost.pulls.filter((p) => p.usd > 0);
  if (spent.length === 0) return `Cost ${usd2(cost.totalUsd)}`;
  const parts = [`this issue ${usd2(cost.ownUsd)}`, ...spent.map((p) => `#${p.number} ${usd2(p.usd)}`)];
  return `Cost ${usd2(cost.totalUsd)}: ${parts.join(", ")}`;
}

/** One row of the cost: a label, the dollars, and the pull it is when it is one. */
export interface CostRow {
  readonly label: string;
  readonly usd: number;
  readonly pull?: number;
}

/**
 * The cost as rows both doors show: the total, then, when a pull spent
 * anything, this issue's own runs and each pull that did.
 */
export function costRows(cost: IssueCost): CostRow[] {
  const rows: CostRow[] = [{ label: "Cost", usd: cost.totalUsd }];
  const spent = cost.pulls.filter((p) => p.usd > 0);
  if (spent.length === 0) return rows;
  rows.push({ label: "This issue", usd: cost.ownUsd });
  for (const p of spent) rows.push({ label: "Pull", usd: p.usd, pull: p.number });
  return rows;
}
