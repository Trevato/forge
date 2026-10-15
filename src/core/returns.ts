/**
 * What the tokens bought: the crew's spend in a window set against what it
 * landed. Every agent run is attributed to the change it worked toward — the
 * pull it ran on, the pull opened from its branch, or a pull that says it
 * closes its issue — and that change either merged, or it did not. So the
 * window's dollars split cleanly in two: spend on work that landed (with a
 * cost per landed change), and spend that landed nothing, by why.
 *
 * "Closed without a merge" is read from the pulls, never from an issue's
 * close reason, which most closed issues do not carry. Dollars are the
 * provider's list price as each run reported it (`run.cost_usd`).
 *
 * Pure data over the run, issue and pull tables: who may read it is the
 * caller's to decide (owner facts only; `actions/returns.ts`).
 */

import type { Database } from "bun:sqlite";
import { NO_PILLAR, pillarsOf, servedBy } from "./pillars.ts";
import { closesFromBody } from "./pulls.ts";
import { getReposByIds } from "./repos.ts";

export interface ReturnsWindow {
  readonly since: string;
  readonly until: string;
}

export interface Money {
  readonly runs: number;
  readonly usd: number;
}

export interface Reason extends Money {
  /** The run's own summary, with numbers folded so repeats group together. */
  readonly reason: string;
}

export type Outcome = "landed" | "closed" | "open";

export interface CostlyIssue extends Money {
  readonly repoId: string;
  readonly number: number;
  readonly title: string;
  /** Landed: a change for it merged. Closed: it closed with nothing merged. Open: still nothing merged. */
  readonly outcome: Outcome;
}

/** What one pillar's work cost and came to; "no pillar" is the work that serves none. */
export interface PillarReturn extends Money {
  readonly pillar: string;
  /** Distinct changes that merged for this pillar's runs. */
  readonly changes: number;
  /** Dollars on work that landed. */
  readonly landedUsd: number;
  /** Dollars on work that landed, over those changes; 0 when none landed. */
  readonly perChange: number;
  readonly closed: Money;
  readonly open: Money;
}

export interface Returns {
  readonly window: ReturnsWindow;
  /** Every agent run in the window. */
  readonly spent: Money;
  /** The same, by the run's own state. */
  readonly byState: Readonly<Record<string, Money>>;
  /** Pulls merged in the window. */
  readonly landed: number;
  /** Runs whose change merged, and what a landed change cost: total and median over the changes. */
  readonly onLanded: Money & {
    readonly perChange: {
      readonly median: number;
      readonly total: number;
      readonly changes: number;
    };
  };
  /** Runs whose change has not merged: the work closed without a merge, or still open. */
  readonly landedNothing: Money & {
    readonly closed: Money;
    readonly open: Money;
    readonly failed: Money;
    readonly cancelled: Money;
    /** The costliest reasons runs failed, most dollars first. */
    readonly topFailures: readonly Reason[];
  };
  /** A run that finished well: what one costs and how long it takes. */
  readonly okRun: {
    readonly usd: { readonly median: number; readonly p90: number };
    readonly minutes: { readonly median: number; readonly p90: number };
  };
  /** The same dollars by the pillar each run's issue serves: pillars in order, no pillar last. */
  readonly byPillar: readonly PillarReturn[];
  /** The issues that cost the most, with what came of each. */
  readonly costliest: readonly CostlyIssue[];
}

interface RunRow {
  id: string;
  repo_id: string;
  issue_id: string | null;
  branch: string;
  state: string;
  summary: string;
  cost_usd: number;
  started_at: string | null;
  finished_at: string | null;
}

interface PullRow {
  id: string;
  repo_id: string;
  number: number;
  body: string;
  state: string;
  head_branch: string;
  merged_at: string | null;
}

interface IssueRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  kind: string;
  state: string;
}

const TOP_FAILURES = 6;
const TOP_ISSUES = 10;

const cents = (n: number): number => Math.round(n * 100) / 100;

const at = (sorted: readonly number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/**
 * A failure's summary as a reason that groups its repeats: the first clause
 * only, numbers folded, and the filler a run varies from one telling to the
 * next ("again", "previous") dropped — so "my own reply again" and "my own
 * previous reply" are one reason, with one dollar figure.
 */
export const reasonOf = (summary: string): string =>
  summary
    .replace(/\d+/g, "N")
    .split(/[,.;]/)[0]!
    .replace(/\b(again|previous|still)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "no reason given";

function add(
  into: Map<string, { runs: number; usd: number }>,
  key: string,
  usd: number,
): void {
  const m = into.get(key) ?? { runs: 0, usd: 0 };
  m.runs++;
  m.usd += usd;
  into.set(key, m);
}

const money = (m: { runs: number; usd: number } | undefined): Money => ({
  runs: m?.runs ?? 0,
  usd: cents(m?.usd ?? 0),
});

const marks = (n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/** What the tokens bought in these repositories over the window. */
export function tokenReturns(
  db: Database,
  repoIds: readonly string[],
  window: ReturnsWindow,
): Returns {
  const n = repoIds.length;
  const runs =
    n === 0
      ? []
      : db
          .query<RunRow, string[]>(
            `SELECT id, repo_id, issue_id, branch, state, summary, cost_usd, started_at, finished_at
             FROM run WHERE kind = 'agent' AND repo_id IN (${marks(n)})
               AND created_at >= ?${n + 1} AND created_at < ?${n + 2}`,
          )
          .all(...repoIds, window.since, window.until);
  // Every pull in these repositories, once: what a run's work became.
  const pulls =
    n === 0
      ? []
      : db
          .query<PullRow, string[]>(
            `SELECT issue.id, issue.repo_id, issue.number, issue.body, issue.state,
                    pull.head_branch, pull.merged_at
             FROM issue JOIN pull ON pull.issue_id = issue.id
             WHERE issue.repo_id IN (${marks(n)})`,
          )
          .all(...repoIds);
  const pullById = new Map(pulls.map((p) => [p.id, p]));
  const byBranch = new Map<string, PullRow[]>();
  const closing = new Map<string, PullRow[]>();
  for (const p of pulls) {
    const b = `${p.repo_id}\u0000${p.head_branch}`;
    byBranch.set(b, [...(byBranch.get(b) ?? []), p]);
    for (const k of closesFromBody(p.body)) {
      const c = `${p.repo_id}#${k}`;
      closing.set(c, [...(closing.get(c) ?? []), p]);
    }
  }
  const issueIds = [
    ...new Set(runs.flatMap((r) => (r.issue_id === null ? [] : [r.issue_id]))),
  ];
  const issues = new Map<string, IssueRow>();
  for (let i = 0; i < issueIds.length; i += 400) {
    const batch = issueIds.slice(i, i + 400);
    for (const row of db
      .query<
        IssueRow,
        string[]
      >(`SELECT id, repo_id, number, title, kind, state FROM issue WHERE id IN (${marks(batch.length)})`)
      .all(...batch))
      issues.set(row.id, row);
  }

  // Which pillar each issue serves, per repository: one read of the plan each.
  const repoById = getReposByIds(db, repoIds);
  const order: string[] = [];
  const served = new Map<string, string>();
  for (const repo of repoById.values()) {
    const set = pillarsOf(db, repo);
    for (const [id, name] of servedBy(db, set)) served.set(id, name);
    for (const pillar of set.pillars)
      if (!order.includes(pillar.name)) order.push(pillar.name);
    if ((set.gate !== undefined || set.later !== undefined) && !order.includes("Later"))
      order.push("Later");
  }
  const byNumber = db.query<{ id: string }, [string, number]>(
    "SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2",
  );
  /** The pillar a run's issue serves; a pull takes the first pillar of what it closes. */
  const pillarOfIssue = (issue: IssueRow | undefined): string => {
    if (issue === undefined) return NO_PILLAR;
    const own = served.get(issue.id);
    if (own !== undefined || issue.kind !== "pull") return own ?? NO_PILLAR;
    for (const k of closesFromBody(pullById.get(issue.id)?.body ?? "")) {
      const target = byNumber.get(issue.repo_id, k);
      const name = target === null ? undefined : served.get(target.id);
      if (name !== undefined) return name;
    }
    return NO_PILLAR;
  };
  interface Tally {
    runs: number;
    usd: number;
    landedUsd: number;
    changes: Set<string>;
    closed: { runs: number; usd: number };
    open: { runs: number; usd: number };
  }
  const tallies = new Map<string, Tally>();

  /** The change a run worked toward: the merged pull if any of its candidates merged, else what is left. */
  const changeOf = (r: RunRow): { merged?: PullRow; candidates: PullRow[] } => {
    const issue = r.issue_id === null ? undefined : issues.get(r.issue_id);
    const own = issue?.kind === "pull" ? pullById.get(issue.id) : undefined;
    const candidates = [
      ...(own === undefined ? [] : [own]),
      ...(r.branch === ""
        ? []
        : (byBranch.get(`${r.repo_id}\u0000${r.branch}`) ?? [])),
      ...(issue === undefined || issue.kind === "pull"
        ? []
        : (closing.get(`${issue.repo_id}#${issue.number}`) ?? [])),
    ];
    const merged = candidates.find((p) => p.merged_at !== null);
    return merged === undefined ? { candidates } : { merged, candidates };
  };

  const byState = new Map<string, { runs: number; usd: number }>();
  const perChange = new Map<string, number>();
  const nothing = new Map<string, { runs: number; usd: number }>();
  const failures = new Map<string, { runs: number; usd: number }>();
  const perIssue = new Map<
    string,
    { runs: number; usd: number; outcome: Outcome }
  >();
  let spentUsd = 0;
  let landedRuns = 0;
  let landedUsd = 0;
  const okUsd: number[] = [];
  const okMinutes: number[] = [];
  for (const r of runs) {
    const usd = r.cost_usd ?? 0;
    spentUsd += usd;
    add(byState, r.state, usd);
    if (r.state === "ok") {
      okUsd.push(usd);
      if (r.started_at !== null && r.finished_at !== null)
        okMinutes.push(
          (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60_000,
        );
    }
    const change = changeOf(r);
    const issue = r.issue_id === null ? undefined : issues.get(r.issue_id);
    let outcome: Outcome;
    if (change.merged !== undefined) {
      outcome = "landed";
      landedRuns++;
      landedUsd += usd;
      perChange.set(
        change.merged.id,
        (perChange.get(change.merged.id) ?? 0) + usd,
      );
    } else {
      // Closed without a merge, read from the pulls and the issue — never a close reason.
      const closed =
        issue !== undefined
          ? issue.state !== "open" &&
            change.candidates.every((p) => p.state !== "open")
          : change.candidates.length > 0 &&
            change.candidates.every((p) => p.state !== "open");
      outcome = closed ? "closed" : "open";
      add(nothing, outcome, usd);
      if (r.state === "failed") {
        add(nothing, "failed", usd);
        add(failures, reasonOf(r.summary), usd);
      } else if (r.state === "cancelled") add(nothing, "cancelled", usd);
    }
    const tally = tallies.get(pillarOfIssue(issue)) ?? {
      runs: 0,
      usd: 0,
      landedUsd: 0,
      changes: new Set<string>(),
      closed: { runs: 0, usd: 0 },
      open: { runs: 0, usd: 0 },
    };
    tally.runs++;
    tally.usd += usd;
    if (outcome === "landed") {
      tally.landedUsd += usd;
      tally.changes.add(change.merged!.id);
    } else {
      tally[outcome].runs++;
      tally[outcome].usd += usd;
    }
    tallies.set(pillarOfIssue(issue), tally);
    if (issue !== undefined) {
      const m = perIssue.get(issue.id) ?? { runs: 0, usd: 0, outcome };
      m.runs++;
      m.usd += usd;
      // An issue is landed once any of its runs' work landed.
      if (outcome === "landed") m.outcome = "landed";
      perIssue.set(issue.id, m);
    }
  }

  const landed =
    n === 0
      ? 0
      : (db
          .query<{ n: number }, string[]>(
            `SELECT COUNT(*) AS n FROM pull JOIN issue ON issue.id = pull.issue_id
             WHERE issue.repo_id IN (${marks(n)})
               AND pull.merged_at >= ?${n + 1} AND pull.merged_at < ?${n + 2}`,
          )
          .get(...repoIds, window.since, window.until)?.n ?? 0);
  const changeCosts = [...perChange.values()].sort((a, b) => a - b);
  const closed = money(nothing.get("closed"));
  const open = money(nothing.get("open"));
  return {
    window,
    spent: { runs: runs.length, usd: cents(spentUsd) },
    byState: Object.fromEntries([...byState].map(([k, v]) => [k, money(v)])),
    landed,
    onLanded: {
      runs: landedRuns,
      usd: cents(landedUsd),
      perChange: {
        median: cents(at(changeCosts, 0.5)),
        total: cents(landedUsd),
        changes: changeCosts.length,
      },
    },
    landedNothing: {
      runs: closed.runs + open.runs,
      usd: cents(
        (nothing.get("closed")?.usd ?? 0) + (nothing.get("open")?.usd ?? 0),
      ),
      closed,
      open,
      failed: money(nothing.get("failed")),
      cancelled: money(nothing.get("cancelled")),
      topFailures: [...failures]
        .sort((a, b) => b[1].usd - a[1].usd)
        .slice(0, TOP_FAILURES)
        .map(([reason, m]) => ({ reason, ...money(m) })),
    },
    okRun: {
      usd: {
        median: cents(
          at(
            [...okUsd].sort((a, b) => a - b),
            0.5,
          ),
        ),
        p90: cents(
          at(
            [...okUsd].sort((a, b) => a - b),
            0.9,
          ),
        ),
      },
      minutes: {
        median: Math.round(
          at(
            [...okMinutes].sort((a, b) => a - b),
            0.5,
          ),
        ),
        p90: Math.round(
          at(
            [...okMinutes].sort((a, b) => a - b),
            0.9,
          ),
        ),
      },
    },
    byPillar: [...order, NO_PILLAR].flatMap((pillar) => {
      const t = tallies.get(pillar);
      return t === undefined
        ? []
        : [
            {
              pillar,
              ...money(t),
              changes: t.changes.size,
              landedUsd: cents(t.landedUsd),
              perChange:
                t.changes.size === 0 ? 0 : cents(t.landedUsd / t.changes.size),
              closed: money(t.closed),
              open: money(t.open),
            },
          ];
    }),
    costliest: [...perIssue]
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, TOP_ISSUES)
      .map(([id, m]) => {
        const issue = issues.get(id)!;
        return {
          repoId: issue.repo_id,
          number: issue.number,
          title: issue.title,
          outcome: m.outcome,
          ...money(m),
        };
      }),
  };
}
