/**
 * The "stuck pull" flow alarm (#5930): nothing approved sits still. It fires
 * when an approved, open pull has had no event — a run, a check, a review, a
 * push — for `STUCK_MINUTES`, and names the one that has waited longest as
 * `owner/name#N`. Held pulls never count: a person said "not yet". Scoped
 * like the other flow readings: the repositories the crew finishes (or one
 * `repoId`), and `publicOnly` leaves private ones out for a reader who must
 * not learn their names. Pure over the database and `now`; nothing draws it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { reviewSummariesFor } from "../core/reviews.ts";
import { wallWords } from "./wall_wait.ts";

export const STUCK_MINUTES = 30;

export interface StuckAlarm {
  readonly fired: boolean;
  /** When the oldest stuck pull's last event happened; set only when fired. */
  readonly since?: string;
  /** The pull it names, `owner/name` and number; set only when fired. */
  readonly repo?: string;
  readonly number?: number;
  /** Set when the access wall holds it: a person must decide, in plain words (#7847). */
  readonly wall?: readonly string[];
  readonly says: string;
}

export interface StuckScope {
  /** Leave out private repositories. */
  readonly publicOnly?: boolean;
  /** Only this repository, autonomous or not; default is every autonomous one. */
  readonly repoId?: string;
}

interface PullRow {
  id: string;
  repo: string;
  number: number;
  repo_id: string;
  head_repo_id: string | null;
  head_branch: string;
  head_oid: string;
}
interface Last {
  at: string;
  what: string;
}

/** Newest first wins; ISO timestamps compare as text. */
const later = (a: Last | undefined, b: Last): Last =>
  a === undefined || b.at > a.at ? b : a;

function lastEvent(db: Database, p: PullRow): Last | undefined {
  let last: Last | undefined;
  const review = db
    .query<{ at: string }, [string]>(
      "SELECT MAX(created_at) AS at FROM review WHERE issue_id = ?1",
    )
    .get(p.id);
  if (review?.at) last = later(last, { at: review.at, what: "a review" });
  const runs = db
    .query<
      { kind: string; state: string; at: string },
      [string]
    >(`SELECT kind, state, COALESCE(finished_at, started_at, created_at) AS at
         FROM run WHERE issue_id = ?1 ORDER BY at DESC, id DESC LIMIT 1`)
    .get(p.id);
  if (runs !== null) {
    const what =
      runs.kind !== "check"
        ? "a run"
        : runs.state === "failed"
          ? "a red check"
          : runs.state === "ok"
            ? "a green check"
            : "a check";
    last = later(last, { at: runs.at, what });
  }
  const released = db
    .query<{ at: string | null }, [string]>(
      "SELECT MAX(released_at) AS at FROM pull_hold WHERE issue_id = ?1",
    )
    .get(p.id);
  if (released?.at) last = later(last, { at: released.at, what: "a release" });
  // Exact ref match on the parsed payload: no LIKE, so no wildcards in a branch
  // name. A push older than the events found so far cannot change the answer,
  // so only newer ones are parsed.
  const push = db
    .query<
      { at: string | null },
      [string, string, string]
    >(`SELECT MAX(e.created_at) AS at FROM event e, json_each(e.payload, '$.updates') u
        WHERE e.kind = 'push' AND e.repo_id = ?1 AND e.created_at > ?3
          AND json_extract(u.value, '$.ref') = ?2`)
    .get(p.head_repo_id ?? p.repo_id, `refs/heads/${p.head_branch}`, last?.at ?? "");
  if (push?.at) last = later(last, { at: push.at, what: "a push" });
  return last;
}

function sat(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const [n, unit] =
    m >= 1440 ? [Math.floor(m / 1440), "day"] : m >= 60 ? [Math.floor(m / 60), "hour"] : [m, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function alarmStuck(from: App | Database, now: Date, scope: StuckScope = {}): StuckAlarm {
  const db = "db" in from ? from.db : from;
  const pulls = db
    .query<PullRow, [string | null, number]>(
      `SELECT issue.id, o.username || '/' || r.name AS repo, issue.number, issue.repo_id,
              pull.head_repo_id, pull.head_branch, pull.head_oid
         FROM issue JOIN pull ON pull.issue_id = issue.id
         JOIN repo r ON r.id = issue.repo_id JOIN user o ON o.id = r.owner_id
        WHERE issue.kind = 'pull' AND issue.state = 'open' AND pull.merged_at IS NULL
          AND (CASE WHEN ?1 IS NULL THEN r.autonomy != 'off' ELSE r.id = ?1 END)
          AND (?2 = 0 OR r.visibility = 'public')
          AND NOT EXISTS (SELECT 1 FROM pull_hold h WHERE h.issue_id = issue.id AND h.released_at IS NULL)`,
    )
    .all(scope.repoId ?? null, scope.publicOnly ? 1 : 0);
  const verdicts = reviewSummariesFor(db, pulls.map((p) => ({ id: p.id, headOid: p.head_oid })));
  let oldest: { repo: string; number: number; last: Last; head: string; id: string } | undefined;
  for (const p of pulls) {
    const s = verdicts.get(p.id);
    if (s === undefined || s.approvals === 0 || s.changesRequested > 0) continue;
    const last = lastEvent(db, p);
    if (last === undefined || now.getTime() - Date.parse(last.at) < STUCK_MINUTES * 60_000) continue;
    if (oldest === undefined || last.at < oldest.last.at) oldest = { repo: p.repo, number: p.number, last, head: p.head_oid, id: p.id };
  }
  if (oldest === undefined) return { fired: false, says: "No approved pull is sitting still." };
  const { repo, number, last } = oldest;
  const hhmm = new Date(last.at).toISOString().slice(11, 16);
  const wall = wallWords(db, oldest.id, oldest.head);
  if (wall !== null)
    return {
      fired: true,
      since: last.at,
      repo,
      number,
      wall,
      says: `${repo}#${number} is approved and waits for a person to merge it.`,
    };
  return {
    fired: true,
    since: last.at,
    repo,
    number,
    says: `${repo}#${number} has sat approved for ${sat(now.getTime() - Date.parse(last.at))}; its last event was ${last.what} at ${hhmm}.`,
  };
}
