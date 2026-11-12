/**
 * What each word of home's Now line counts, as the rows themselves: check,
 * review, land and live. The same predicates as `pipeline.ts` tallies, so a
 * list's length is the number on home. Plain data out, forge-wide: the
 * caller has checked the viewer is a site admin, as home does.
 */

import type { Database } from "bun:sqlite";

export const NOW_STAGES = ["check", "review", "land", "live"] as const;
export type NowStage = (typeof NOW_STAGES)[number];

export const NOW_WORDS: Record<NowStage, string> = {
  check: "Check",
  review: "Review",
  land: "Land",
  live: "Live",
};

/** What the word counts, in a line under the heading. */
export const NOW_HOLDS: Record<NowStage, string> = {
  check: "Checks queued or running, across every repository.",
  review: "Reviews queued or running on open pulls.",
  land: "Open pulls approved and waiting to land.",
  live: "Production deploys that went live in the last 24 hours.",
};

export interface NowRow {
  readonly title: string;
  readonly href: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly at: string;
  /** What this row is, in a word: "pull #3", "main", "deploy". */
  readonly note: string;
}

interface Raw {
  owner: string;
  name: string;
  number: number | null;
  title: string | null;
  run_id: string | null;
  env: string;
  at: string;
}

const DAY_MS = 24 * 3_600_000;

// A queued run paused on a limit (`not_before` ahead) is not waiting for a worker: `runTally`'s rule.
const RUNS = (kind: string, where: string): string => `
  SELECT u.username AS owner, r.name AS name, i.number AS number, i.title AS title,
         x.id AS run_id, x.env AS env, x.created_at AS at
    FROM run x JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
    LEFT JOIN issue i ON i.id = x.issue_id
   WHERE x.kind = '${kind}' AND ${where}
     AND (x.state = 'running' OR x.not_before IS NULL OR x.not_before <= ?1)
   ORDER BY x.created_at DESC, x.id DESC`;

const SQL: Record<NowStage, string> = {
  check: RUNS("check", "x.state IN ('queued','running')"),
  review: RUNS("agent", "x.reason = 'review' AND x.state IN ('queued','running')"),
  land: `
  SELECT u.username AS owner, r.name AS name, i.number AS number, i.title AS title,
         NULL AS run_id, '' AS env, v.created_at AS at
    FROM issue i JOIN pull p ON p.issue_id = i.id
    JOIN review v ON v.id = (SELECT id FROM review WHERE issue_id = i.id AND state != 'commented'
                              ORDER BY created_at DESC, id DESC LIMIT 1)
    JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
   WHERE i.state = 'open' AND v.state = 'approved'
   ORDER BY v.created_at DESC`,
  live: `
  SELECT u.username AS owner, r.name AS name, NULL AS number, NULL AS title,
         x.id AS run_id, x.env AS env, x.serving_at AS at
    FROM run x JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
   WHERE x.kind = 'deploy' AND x.env = 'production' AND x.serving_at >= ?1
   ORDER BY x.serving_at DESC, x.id DESC`,
};

/** Rows read and listed: the queue can grow, a page of it cannot. */
export const NOW_LISTED = 200;

/** Whether the viewer is shown the Now line and its lists: a site admin who is a person, as home decides it. */
export const mayReadNow = (user: { isAdmin: boolean; kind: string } | undefined): boolean =>
  user !== undefined && user.isAdmin && user.kind !== "agent";

export interface NowList {
  /** What home counts for the stage. */
  readonly total: number;
  /** The newest `NOW_LISTED` of them; fewer than `total` only when the list is cut off. */
  readonly rows: NowRow[];
}

/** The stage's items, newest first: `check` and `review` are runs; `land` is pulls; `live` is deploys. */
export function readNowRows(db: Database, stage: NowStage, now = new Date()): NowList {
  const args: string[] = stage === "land" ? [] : [stage === "live" ? new Date(now.getTime() - DAY_MS).toISOString() : now.toISOString()];
  const counted = db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM (${SQL[stage]})`).get(...args);
  const rows = db.query<Raw, string[]>(`${SQL[stage]} LIMIT ${NOW_LISTED}`).all(...args);
  return {
    total: counted?.n ?? 0,
    rows: rows.map((r) => {
      const repo = `${r.owner}/${r.name}`;
      const base = `/${r.owner}/${r.name}`;
      if (r.number !== null && stage === "land")
        return { title: r.title ?? "", href: `${base}/pulls/${r.number}`, repo, at: r.at, note: `pull #${r.number}` };
      const where = r.number !== null ? `pull #${r.number}` : r.env === "" ? "main" : r.env;
      return {
        title: r.title ?? (stage === "live" ? "Deploy to production" : `Check of ${where}`),
        href: r.run_id === null ? base : `${base}/runs/${r.run_id}`,
        repo,
        at: r.at,
        note: where,
      };
    }),
  };
}
