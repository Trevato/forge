/**
 * How a team coordinates, in figures: throughput, lead time, hand-off
 * latency, rework, conflicts, cost per shipped change and parallelism.
 *
 * `teamMetrics` is pure: plain runs, items, events and decisions in, plain
 * numbers out, for one window. `teamLedger` reads that plain data for one org
 * team from the database: the agent runs of its members, the issues and pulls
 * those runs touched or those members opened, their reopen events and review
 * decisions.
 */

import type { Database } from "bun:sqlite";
import { duration } from "./slider.ts";

export type Role = "planner" | "builder" | "reviewer" | "member";

/** One agent run; times in epoch milliseconds. */
export interface LedgerRun {
  readonly item: string;
  readonly role: Role;
  /** `conflict` when main moved under the pull and the run went again. */
  readonly reason: string;
  readonly costUsd: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/** An issue or pull the team worked; `authorRole` is null when no member opened it. */
export interface LedgerItem {
  readonly id: string;
  readonly kind: "issue" | "pull";
  readonly authorRole: Role | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly mergedAt: number | null;
}

export interface LedgerEvent {
  readonly item: string;
  readonly kind: "reopened";
  readonly at: number;
}

export interface LedgerDecision {
  readonly item: string;
  readonly state: "approved" | "changes_requested" | "commented";
  readonly at: number;
}

export interface Ledger {
  readonly runs: readonly LedgerRun[];
  readonly items: readonly LedgerItem[];
  readonly events: readonly LedgerEvent[];
  readonly decisions: readonly LedgerDecision[];
  /** How many runs the team may hold at once: its agents, one run each. */
  readonly slots: number;
}

export interface TeamMetrics {
  readonly hours: number;
  /** Issues closed in the window, per hour. */
  readonly closedPerHour: number;
  /** Opened → closed of the issues closed in the window, in ms; null with none. */
  readonly leadMedianMs: number | null;
  readonly leadP90Ms: number | null;
  /** Median wait from a planner's hand-off to a builder's run starting. */
  readonly plannerToBuilderMs: number | null;
  /** Median wait from a builder's pull to its first review (a run or a decision). */
  readonly builderToReviewerMs: number | null;
  /** Of the changes finished in the window, the share sent back: changes requested or reopened. */
  readonly reworkRate: number | null;
  /** Of the runs started in the window, the share that went again over a conflict. */
  readonly conflictRate: number | null;
  /** What the window's runs cost, over the pulls merged in it. */
  readonly costPerShippedUsd: number | null;
  readonly shipped: number;
  /** Mean runs in flight across the window, beside the slots it could hold. */
  readonly parallelism: number;
  readonly slots: number;
}

/** The nearest-rank quantile of sorted numbers; null when there are none. */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const inside = (t: number | null, from: number, to: number): t is number =>
  t !== null && t >= from && t < to;
const ascending = (xs: number[]): number[] => xs.sort((a, b) => a - b);

function byItem<T extends { item: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.item);
    if (list) list.push(r);
    else out.set(r.item, [r]);
  }
  return out;
}

/** The figures of one team over `[from, to)`, epoch milliseconds. */
export function teamMetrics(ledger: Ledger, from: number, to: number): TeamMetrics {
  const span = Math.max(1, to - from);
  const hours = span / 3_600_000;
  const runsOf = byItem(ledger.runs);
  const decisionsOf = byItem(ledger.decisions);
  const reopenedItems = new Set(ledger.events.filter((e) => e.at < to).map((e) => e.item));

  const closed = ledger.items.filter((i) => i.kind === "issue" && inside(i.closedAt, from, to));
  const leads = ascending(closed.map((i) => i.closedAt! - i.openedAt));

  const planToBuild: number[] = [];
  const buildToReview: number[] = [];
  for (const item of ledger.items) {
    const runs = runsOf.get(item.id) ?? [];
    if (item.kind === "issue") {
      const built = runs
        .filter((r) => r.role === "builder" && r.startedAt !== null)
        .map((r) => r.startedAt!);
      if (built.length === 0) continue;
      const start = Math.min(...built);
      if (!inside(start, from, to)) continue;
      const handed = runs
        .filter((r) => r.role === "planner" && r.finishedAt !== null && r.finishedAt <= start)
        .map((r) => r.finishedAt!);
      if (item.authorRole === "planner" && item.openedAt <= start) handed.push(item.openedAt);
      if (handed.length > 0) planToBuild.push(start - Math.max(...handed));
    } else {
      const handed =
        item.authorRole === "builder"
          ? item.openedAt
          : Math.min(
              ...runs.filter((r) => r.role === "builder" && r.finishedAt !== null).map((r) => r.finishedAt!),
            );
      if (!Number.isFinite(handed)) continue;
      const reviewed = Math.min(
        ...runs.filter((r) => r.role === "reviewer" && r.startedAt !== null && r.startedAt >= handed).map((r) => r.startedAt!),
        ...(decisionsOf.get(item.id) ?? []).filter((d) => d.at >= handed).map((d) => d.at),
      );
      if (inside(Number.isFinite(reviewed) ? reviewed : null, from, to)) buildToReview.push(reviewed - handed);
    }
  }

  const merged = ledger.items.filter((i) => i.kind === "pull" && inside(i.mergedAt, from, to));
  const finished = [...merged, ...closed];
  const reworked = finished.filter(
    (i) =>
      reopenedItems.has(i.id) ||
      (decisionsOf.get(i.id) ?? []).some((d) => d.state === "changes_requested" && d.at < to),
  ).length;

  const started = ledger.runs.filter((r) => inside(r.startedAt, from, to));
  const conflicts = started.filter((r) => r.reason === "conflict").length;
  const spent = started.reduce((sum, r) => sum + r.costUsd, 0);

  let busy = 0;
  for (const r of ledger.runs) {
    if (r.startedAt === null) continue;
    const end = Math.min(r.finishedAt ?? to, to);
    const begin = Math.max(r.startedAt, from);
    if (end > begin) busy += end - begin;
  }

  return {
    hours,
    closedPerHour: closed.length / hours,
    leadMedianMs: quantile(leads, 0.5),
    leadP90Ms: quantile(leads, 0.9),
    plannerToBuilderMs: quantile(ascending(planToBuild), 0.5),
    builderToReviewerMs: quantile(ascending(buildToReview), 0.5),
    reworkRate: ratio(reworked, finished.length),
    conflictRate: ratio(conflicts, started.length),
    costPerShippedUsd: ratio(spent, merged.length),
    shipped: merged.length,
    parallelism: busy / span,
    slots: ledger.slots,
  };
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function asRole(raw: string | undefined): Role {
  return raw === "planner" || raw === "builder" || raw === "reviewer" ? raw : "member";
}

/**
 * The ledger of org team `teamId` since `since` (epoch ms): its members' agent
 * runs, the items they touched or opened, reopens and review decisions.
 */
export function teamLedger(db: Database, teamId: string, since: number): Ledger {
  const roles = new Map(
    db
      .query<{ user_id: string; role: string }, [string]>(
        "SELECT user_id, role FROM team_member WHERE team_id = ?1",
      )
      .all(teamId)
      .map((m) => [m.user_id, asRole(m.role)] as const),
  );
  // A slot is a seat on the crew: people on the team as plain members run nothing.
  const slots = [...roles.values()].filter((r) => r !== "member").length;
  if (roles.size === 0) return { runs: [], items: [], events: [], decisions: [], slots };
  const sinceIso = new Date(since).toISOString();

  // Values, not objects, each member's runs a seek on `run_agent_actor`, never a scan of every run.
  const runs: LedgerRun[] = (db
    .query<Record<string, never>, [string, string]>(
      `SELECT run.issue_id, run.actor_id, run.reason, run.cost_usd, run.started_at, run.finished_at
         FROM team_member JOIN run INDEXED BY run_agent_actor ON run.actor_id = team_member.user_id
        WHERE team_member.team_id = ?1 AND run.kind = 'agent' AND run.issue_id IS NOT NULL
          AND (run.finished_at IS NULL OR run.finished_at >= ?2)`,
    )
    .values(teamId, sinceIso) as [string, string, string, number, string | null, string | null][])
    .map(([item, actor, reason, costUsd, started, finished]) => ({
      item,
      role: roles.get(actor) ?? "member",
      reason,
      costUsd,
      startedAt: ms(started),
      finishedAt: ms(finished),
    }));

  // The items those runs touched, and the ones members opened, unless closed before the ledger.
  const rows = db
    .query<Record<string, never>, [string, string, string]>(
      `SELECT issue.id, issue.kind, issue.author_id, issue.repo_id, issue.number, issue.created_at,
              issue.closed_at, pull.merged_at
         FROM issue LEFT JOIN pull ON pull.issue_id = issue.id
        WHERE (issue.closed_at IS NULL OR issue.closed_at >= ?3)
          AND (issue.id IN (SELECT value FROM json_each(?1))
               OR issue.author_id IN (SELECT user_id FROM team_member WHERE team_id = ?2))`,
    )
    .values(JSON.stringify([...new Set(runs.map((r) => r.item))]), teamId, sinceIso) as [
    string, string, string, string, number, string, string | null, string | null,
  ][];
  const items: LedgerItem[] = rows.map(([id, kind, author, , , created, closed, merged]) => ({
    id,
    kind: kind === "pull" ? "pull" : "issue",
    authorRole: roles.get(author) ?? null,
    openedAt: ms(created) ?? 0,
    closedAt: ms(closed),
    mergedAt: ms(merged),
  }));
  const byNumber = new Map(rows.map((r) => [`${r[3]}#${r[4]}`, r[0]]));
  // Reopens and review decisions of those items only: a seek per repository
  // on `event_repo_kind_seq` and per item on `review_issue`, never the forge's whole window.
  const ids = JSON.stringify(rows.map((r) => r[0]));
  const repos = JSON.stringify([...new Set(rows.map((r) => r[3]))]);
  const events: LedgerEvent[] = db
    .query<{ repo_id: string | null; number: number | null; created_at: string }, [string, string]>(
      `SELECT repo_id, json_extract(payload, '$.number') AS number, created_at FROM event
        WHERE repo_id IN (SELECT value FROM json_each(?1))
          AND kind IN ('issue.reopened', 'pull.reopened') AND created_at >= ?2`,
    )
    .all(repos, sinceIso)
    .flatMap((e) => {
      const item = byNumber.get(`${e.repo_id}#${e.number}`);
      const at = ms(e.created_at);
      return item && at !== null ? [{ item, kind: "reopened" as const, at }] : [];
    });

  const decisions: LedgerDecision[] = db
    .query<{ issue_id: string; state: string; created_at: string }, [string, string]>(
      `SELECT issue_id, state, created_at FROM review
        WHERE issue_id IN (SELECT value FROM json_each(?1)) AND created_at >= ?2`,
    )
    .all(ids, sinceIso)
    .flatMap((d) => {
      const at = ms(d.created_at);
      return at === null ? [] : [{ item: d.issue_id, state: d.state as LedgerDecision["state"], at }];
    });

  return { runs, items, events, decisions, slots };
}

export const DAY_MS = 86_400_000;

/** How long a team's figures stand before they are read again: a day's and a week's numbers don't move in a minute. */
export const FIGURES_TTL_MS = 60_000;
/** How many teams' figures are kept per database; the one read from the database longest ago goes first, so a deleted team's ages out. */
export const FIGURES_KEPT = 64;
const figures = new WeakMap<Database, Map<string, { at: number; value: { day: TeamMetrics; week: TeamMetrics } }>>();

/**
 * The two windows a team's page, the terminal and the `org_teams` tool show:
 * the last day and the last week, ending at `now`. Kept a minute per team, so
 * a page reload never reads the week's runs twice.
 */
export function teamWindows(db: Database, teamId: string, now: number): { day: TeamMetrics; week: TeamMetrics } {
  let byTeam = figures.get(db);
  if (!byTeam) figures.set(db, (byTeam = new Map()));
  const kept = byTeam.get(teamId);
  if (kept && now - kept.at >= 0 && now - kept.at < FIGURES_TTL_MS) return kept.value;
  const ledger = teamLedger(db, teamId, now - 7 * DAY_MS);
  const value = { day: teamMetrics(ledger, now - DAY_MS, now), week: teamMetrics(ledger, now - 7 * DAY_MS, now) };
  byTeam.delete(teamId);
  byTeam.set(teamId, { at: now, value });
  for (const oldest of byTeam.keys()) {
    if (byTeam.size <= FIGURES_KEPT) break;
    byTeam.delete(oldest);
  }
  return value;
}

/** How many teams' figures `db` holds now; never more than `FIGURES_KEPT`. */
export function keptFigures(db: Database): number {
  return figures.get(db)?.size ?? 0;
}

const pct = (share: number | null): string => (share === null ? "–" : `${Math.round(share * 100)}%`);
const wait = (t: number | null): string => (t === null ? "–" : duration(t));

export interface MetricRow {
  readonly label: string;
  readonly value: string;
}

/**
 * One window's figures as rows of plain words: the page's `dl` and the
 * terminal's list alike. A dash is a figure the window has nothing to measure.
 */
export function metricsRows(m: TeamMetrics): MetricRow[] {
  return [
    { label: "Issues closed", value: `${m.closedPerHour.toFixed(2)} an hour` },
    { label: "Lead time", value: `${wait(m.leadMedianMs)} typical, ${wait(m.leadP90Ms)} for the slowest tenth` },
    { label: "Planner to builder", value: wait(m.plannerToBuilderMs) },
    { label: "Builder to reviewer", value: wait(m.builderToReviewerMs) },
    { label: "Sent back", value: pct(m.reworkRate) },
    { label: "Conflicts", value: m.conflictRate === null ? "–" : `${pct(m.conflictRate)} of runs` },
    {
      label: "Cost per shipped change",
      value: m.costPerShippedUsd === null ? "nothing shipped" : `$${m.costPerShippedUsd.toFixed(2)}, ${m.shipped} shipped`,
    },
    { label: "Slots busy", value: `${m.parallelism.toFixed(1)} of ${m.slots}` },
  ];
}
