/**
 * Scorecard — how each crew member's pulls fare after it opens them: the
 * numbers an owner tunes a crew by (#2677). `agentTotals` (`core/runs.ts`)
 * says what an agent spent and how many of its pulls landed; this says how
 * hard they were to land and whether they stayed landed.
 *
 * Every figure is over the pulls an agent authored — all time, or only those
 * opened (issue.created_at) at or after `since`, so tuning shows movement:
 *
 *   reviewRounds  = count(changes_requested reviews on its landed pulls) ÷ landed
 *   redCheckRate  = failed ÷ finished (ok + failed) check runs on its pulls
 *   reverts       = its landed pulls that a merged pull took back
 *                   (`pull.reverts_issue_id`, named explicitly, never sniffed)
 *   meanLandMs    = mean of merged_at − opened (issue.created_at) over landed
 *
 * A ratio over nothing is null, said as a dash by the page. Only agents
 * appear; an agent that has opened no pull is absent.
 *
 * Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";

export interface Scorecard {
  /** Pulls the agent opened. */
  readonly opened: number;
  /** Of those, merged. */
  readonly landed: number;
  /** Mean changes-requested reviews per landed pull; null before one lands. */
  readonly reviewRounds: number | null;
  /** Share (0–1) of finished check runs on its pulls that failed; null with none. */
  readonly redCheckRate: number | null;
  /** Landed pulls a later merged pull reverted. */
  readonly reverts: number;
  /** Mean milliseconds from opening a pull to its merge; null before one lands. */
  readonly meanLandMs: number | null;
}

/** Which pulls a scorecard counts: all of them, or those opened at or after `since`. */
export interface ScorecardWindow {
  readonly since?: Date;
}

/** The recent window both doors show beside all time, in days. */
export const RECENT_DAYS = 30;

/** Where the recent window starts: `RECENT_DAYS` × 86 400 000 ms before `now`. */
export function recentWindow(now: number = Date.now()): ScorecardWindow {
  return { since: new Date(now - RECENT_DAYS * 86_400_000) };
}

/** Each agent's scorecard, keyed by its user id: one grouped query. */
export function crewScorecards(
  db: Database,
  window: ScorecardWindow = {},
): Map<string, Scorecard> {
  // created_at is stored as ISO-8601 UTC, so the string compare is the time compare.
  // An invalid Date throws here rather than widen the window to all time.
  const since = window.since === undefined ? null : window.since.toISOString();
  const rows = db
    .query<
      {
        author_id: string;
        opened: number;
        landed: number;
        rounds: number;
        checks_ok: number;
        checks_failed: number;
        reverts: number;
        mean_land_days: number | null;
      },
      [string | null]
    >(
      `SELECT issue.author_id AS author_id,
              COUNT(*) AS opened,
              SUM(pull.merged_at IS NOT NULL) AS landed,
              COALESCE(SUM(CASE WHEN pull.merged_at IS NOT NULL THEN
                (SELECT COUNT(*) FROM review
                  WHERE review.issue_id = issue.id
                    AND review.state = 'changes_requested') END), 0) AS rounds,
              COALESCE(SUM((SELECT COUNT(*) FROM run
                  WHERE run.issue_id = issue.id AND run.kind = 'check'
                    AND run.state = 'ok')), 0) AS checks_ok,
              COALESCE(SUM((SELECT COUNT(*) FROM run
                  WHERE run.issue_id = issue.id AND run.kind = 'check'
                    AND run.state = 'failed')), 0) AS checks_failed,
              SUM(pull.merged_at IS NOT NULL AND EXISTS (
                  SELECT 1 FROM pull AS back
                   WHERE back.reverts_issue_id = issue.id
                     AND back.merged_at IS NOT NULL)) AS reverts,
              AVG(CASE WHEN pull.merged_at IS NOT NULL
                       THEN julianday(pull.merged_at) - julianday(issue.created_at) END)
                AS mean_land_days
         FROM issue
         JOIN pull ON pull.issue_id = issue.id
         JOIN user ON user.id = issue.author_id AND user.is_agent = 1
        WHERE ?1 IS NULL OR issue.created_at >= ?1
        GROUP BY issue.author_id`,
    )
    .all(since);
  return new Map(
    rows.map((r) => {
      const checks = r.checks_ok + r.checks_failed;
      return [
        r.author_id,
        {
          opened: r.opened,
          landed: r.landed,
          reviewRounds: r.landed === 0 ? null : r.rounds / r.landed,
          redCheckRate: checks === 0 ? null : r.checks_failed / checks,
          reverts: r.reverts,
          meanLandMs:
            r.mean_land_days === null
              ? null
              : Math.max(0, Math.round(r.mean_land_days * 86_400_000)),
        },
      ];
    }),
  );
}

/** A time to land in the largest unit that keeps it readable: both doors say it the same way. */
export function spanText(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
