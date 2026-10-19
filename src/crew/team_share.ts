/**
 * Teams (#2679) at work (#2680): an issue belongs to the team whose slug is
 * one of its labels, dispatch hands builder starts to teams in proportion to
 * their dials, and the planner is told which teams it owes work today. The
 * rest of the dial (100 minus the sum) is the share of unlabelled work, so a
 * forge with every dial at 0 starts in the order it always did.
 */

import type { Database } from "bun:sqlite";
import type { Run } from "../core/runs.ts";
import { listTeams, type Team } from "../core/teams.ts";

/** The group for work no team owns. */
export const REST = "";
/** Starts are counted over this long. */
export const WINDOW_MS = 24 * 3_600_000;

/**
 * The team slug on an issue: the first team label by team order whose dial is
 * above zero. A zero-dial team's label is ownership without a share, so its
 * work is REST (absent here), not a lane of its own.
 */
export function teamOfIssues(db: Database, issueIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const marks = issueIds.map(() => "?").join(",");
  const rows = db
    .query<{ issue_id: string; slug: string }, string[]>(
      `SELECT il.issue_id, t.slug FROM issue_label il
         JOIN label l ON l.id = il.label_id
         JOIN crew_team t ON t.slug = l.name COLLATE NOCASE AND t.dial > 0
       WHERE il.issue_id IN (${marks}) ORDER BY t.rowid DESC`,
    )
    .all(...issueIds);
  // ORDER BY rowid DESC, so the earliest team wins the overwrite.
  for (const r of rows) out.set(r.issue_id, r.slug);
  return out;
}

/** Each group's share of starts, in percent; REST takes what the dials leave. */
export function sharesOf(teams: readonly Team[]): Map<string, number> {
  const shares = new Map<string, number>();
  let used = 0;
  for (const t of teams) {
    if (t.dial <= 0) continue;
    shares.set(t.slug, t.dial);
    used += t.dial;
  }
  shares.set(REST, Math.max(0, 100 - used));
  return shares;
}

/** Agent runs started since `since`, counted per group. */
export function startsSince(db: Database, since: string): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = db
    .query<{ issue_id: string | null }, [string]>(
      "SELECT issue_id FROM run WHERE kind = 'agent' AND started_at >= ?1",
    )
    .all(since);
  const owner = teamOfIssues(db, rows.flatMap((r) => (r.issue_id ? [r.issue_id] : [])));
  for (const r of rows) {
    const g = (r.issue_id && owner.get(r.issue_id)) || REST;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/**
 * Queued runs (oldest first) in the order they should start: repeatedly the
 * oldest run of the group furthest behind its share of all starts so far.
 * Pure: `groupOf` names a run's group, `counts` is what already started.
 */
export function fairOrder(
  queued: readonly Run[],
  groupOf: (run: Run) => string,
  shares: ReadonlyMap<string, number>,
  counts: ReadonlyMap<string, number>,
): Run[] {
  const lanes = new Map<string, Run[]>();
  for (const run of queued) {
    const g = groupOf(run);
    const lane = lanes.get(g) ?? [];
    lane.push(run);
    lanes.set(g, lane);
  }
  const done = new Map(counts);
  let total = 0;
  for (const n of done.values()) total += n;
  const out: Run[] = [];
  while (out.length < queued.length) {
    let best: string | undefined;
    let bestDeficit = -Infinity;
    for (const [g, lane] of lanes) {
      if (lane.length === 0) continue;
      const share = shares.get(g) ?? 0;
      // A group with no share (REST when the dials sum to 100) goes last.
      const deficit = share === 0 ? -1e9 : (share / 100) * (total + 1) - (done.get(g) ?? 0);
      if (deficit > bestDeficit) {
        best = g;
        bestDeficit = deficit;
      }
    }
    const next = lanes.get(best!)!.shift()!;
    out.push(next);
    done.set(best!, (done.get(best!) ?? 0) + 1);
    total++;
  }
  return out;
}

/** Queued runs reordered by the dials, counting the last day's starts. */
export function byDials(db: Database, queued: Run[], now = Date.now()): Run[] {
  const teams = listTeams(db);
  if (!teams.some((t) => t.dial > 0) || queued.length < 2) return queued;
  const owner = teamOfIssues(db, queued.flatMap((r) => (r.issueId ? [r.issueId] : [])));
  return fairOrder(
    queued,
    (r) => (r.issueId && owner.get(r.issueId)) || REST,
    sharesOf(teams),
    startsSince(db, new Date(now - WINDOW_MS).toISOString()),
  );
}

export interface Owed {
  readonly team: Team;
  /** Open issues carrying the team's label. */
  readonly open: number;
  /** Issues opened with it in the last day. */
  readonly today: number;
}

/** Every team with a dial above zero, with the work it holds in this repository. */
export function owed(db: Database, repoId: string, now = Date.now()): Owed[] {
  const since = new Date(now - WINDOW_MS).toISOString();
  return listTeams(db)
    .filter((t) => t.dial > 0)
    .map((team) => {
      const n = (extra: string, ...args: string[]): number =>
        db
          .query<{ n: number }, string[]>(
            `SELECT COUNT(*) AS n FROM issue i
               JOIN issue_label il ON il.issue_id = i.id
               JOIN label l ON l.id = il.label_id
             WHERE i.repo_id = ?1 AND i.kind = 'issue' AND l.name = ?2 COLLATE NOCASE ${extra}`,
          )
          .get(repoId, team.slug, ...args)!.n;
      return {
        team,
        open: n("AND i.state = 'open'"),
        today: n("AND i.created_at >= ?3", since),
      };
    });
}
