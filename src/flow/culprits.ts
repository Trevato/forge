/**
 * What a red batch was (#7639), kept where the queue judged it so nobody
 * has to look. `real`: the search named one pull, handed back to its
 * builder with the failing tests named, and the rest of the batch went on.
 * `load`: the red is the machine's — infrastructure twice, or a shorter
 * prefix red under a longer green one (a flake) — so no pull is blamed and
 * none is handed back. Forge-wide for the owner, public repositories alone
 * for an agent, the rule `readVitals` keeps.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;
const KEEP_MS = 7 * 24 * HOUR_MS;

/** The window the report reads over. */
export const VERDICT_WINDOW_MS = 24 * HOUR_MS;

/** The most failing test names kept per verdict, and the longest one. */
const MAX_TESTS = 5;
const MAX_NAME = 200;
/** How many verdicts the report lists. */
const LISTED = 5;

export interface QueueVerdict {
  readonly kind: "real" | "load";
  /** Why: `tests`, `typecheck`, `check`, `install`, `setup`, `timeout` or `flake`. */
  readonly why: string;
  /** The pull blamed; none for a load red. */
  readonly pull?: number;
  readonly tests: readonly string[];
}

export interface VerdictRow {
  readonly repo: string;
  readonly kind: "real" | "load";
  readonly why: string;
  readonly pull: number | null;
  readonly tests: string[];
  readonly action: string;
  readonly at: string;
}

export interface Verdicts {
  readonly real: number;
  readonly load: number;
  readonly says: string;
  readonly recent: VerdictRow[];
}

/** What was done about it, in words: the pull goes back to its builder, or nothing is blamed. */
export const actionFor = (v: Pick<QueueVerdict, "kind" | "pull">): string =>
  v.kind === "real" ? `returned #${v.pull ?? "?"} to its builder` : "no pull blamed; the batch carries on";

/** Keep one verdict, and let those past a week go. */
export function keepVerdict(db: Database, repoId: string, v: QueueVerdict, now = new Date()): void {
  const tests = v.tests.slice(0, MAX_TESTS).map((t) => t.slice(0, MAX_NAME));
  db.query(
    `INSERT INTO queue_verdict (repo_id, kind, why, pull_number, tests, action, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(repoId, v.kind, v.why, v.pull ?? null, JSON.stringify(tests), actionFor(v), now.toISOString());
  db.query(`DELETE FROM queue_verdict WHERE at < ?1`).run(new Date(now.getTime() - KEEP_MS).toISOString());
}

/** `publicOnly` reads public repositories alone, for a reader who must not learn what private ones hold. */
export function readVerdicts(db: Database, now = new Date(), publicOnly = false): Verdicts {
  const rows = db
    .query<
      { repo: string; kind: "real" | "load"; why: string; pull_number: number | null; tests: string; action: string; at: string },
      [string, string, number]
    >(
      `SELECT u.username || '/' || r.name AS repo, v.kind, v.why, v.pull_number, v.tests, v.action, v.at
         FROM queue_verdict v JOIN repo r ON r.id = v.repo_id JOIN user u ON u.id = r.owner_id
        WHERE (?3 = 0 OR r.visibility = 'public') AND v.at >= ?1 AND v.at <= ?2
        ORDER BY v.at DESC, v.id DESC`,
    )
    .all(new Date(now.getTime() - VERDICT_WINDOW_MS).toISOString(), now.toISOString(), publicOnly ? 1 : 0);
  const real = rows.filter((r) => r.kind === "real").length;
  const load = rows.length - real;
  const recent = rows.slice(0, LISTED).map((r) => ({
    repo: r.repo,
    kind: r.kind,
    why: r.why,
    pull: r.pull_number,
    tests: JSON.parse(r.tests) as string[],
    action: r.action,
    at: r.at,
  }));
  return { real, load, says: verdictWords(real, load, recent[0]), recent };
}

/** The line: counts, then the newest red named with its tests. */
function verdictWords(real: number, load: number, newest: VerdictRow | undefined): string {
  if (newest === undefined) return "no red batch in 24 h";
  const tests = newest.tests.length === 0 ? newest.why : newest.tests.map((t) => JSON.stringify(t)).join(", ");
  const last =
    newest.kind === "real"
      ? `latest: ${newest.repo}#${newest.pull} broke ${tests}, returned to its builder`
      : `latest: load red (${newest.why}), no pull blamed`;
  return `${real} real, ${load} load in 24 h; ${last}`;
}
