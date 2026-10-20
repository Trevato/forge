/**
 * A red many pulls share is the lane's, not theirs (#2266). One test whose
 * verdict hung on how full the check machine's disk was failed ten pulls in
 * an hour while main's own check stayed green, so the red-main rule
 * (`checks/red_main.ts`) never applied: each was parked, its issue struck,
 * and every one reopened by hand. So when a pull's check fails only on tests
 * that {@link SHARED_PULLS} or more pulls of the repository failed within
 * {@link SHARED_WINDOW_MS}, the crew neither reworks nor parks it; it waits
 * for main's next green check, as a red main's pulls do, and the vitals
 * carry one card per shared test in place of a park per pull.
 *
 * Plain data: failed pull checks in the window, read by the `run_repo`
 * index (an id is time-sortable, so the window is a range), their recorded
 * test names unpacked by SQLite's own `json_each`.
 */

import type { Database } from "bun:sqlite";
import type { Run } from "../core/runs.ts";
import { idFloor } from "../kernel/id.ts";

/** How far back another pull's red on the same test counts. */
export const SHARED_WINDOW_MS = 3_600_000;

/** How many pulls, this one among them, failing one test make it shared. */
export const SHARED_PULLS = 3;

/**
 * Checks are created before they finish; one created this long before the
 * window may still have failed inside it. Bounds the scan, never the answer
 * for any check that ran under its lane's own limits.
 */
const QUEUED_SLACK_MS = 6 * 3_600_000;

/**
 * What `bun test` prints for a failure that belongs to no test (an unhandled
 * error, a hook): unrelated pulls share the label, not a cause, so it never
 * makes a lane's red.
 */
export const NO_TEST_NAME = "(unnamed)";

export interface SharedTest {
  readonly repoId: string;
  /** `owner/name`, for the card. */
  readonly repo: string;
  readonly test: string;
  /** Distinct pulls whose check failed on it in the window. */
  readonly pulls: number;
  /** When the earliest of those checks finished. */
  readonly since: string;
}

interface Row {
  repo_id: string;
  repo: string;
  test: string;
  pulls: number;
  since: string;
}

/**
 * Each test failed by pull checks in the window, with how many distinct
 * pulls failed it. `repo` narrows to one repository; `test` to one name.
 * A constant of this module, never input: every value is a parameter.
 */
const PULLS_PER_TEST = `
  SELECT run.repo_id, u.username || '/' || repo.name AS repo,
         n.value AS test, COUNT(DISTINCT run.issue_id) AS pulls,
         MIN(run.finished_at) AS since
    FROM run
    JOIN repo ON repo.id = run.repo_id
    JOIN user u ON u.id = repo.owner_id,
         json_each(CASE WHEN json_valid(run.check_detail) THEN run.check_detail ELSE '{}' END, '$.names') n
   WHERE run.id >= ?1 AND run.finished_at >= ?2
     AND run.kind = 'check' AND run.issue_id IS NOT NULL AND run.state = 'failed'
     AND (?3 IS NULL OR run.repo_id = ?3)
     AND n.type = 'text' AND n.value <> ?4
   GROUP BY run.repo_id, n.value`;

function pullsPerTest(db: Database, now: number, repoId: string | null): Row[] {
  return db
    .query<Row, [string, string, string | null, string]>(PULLS_PER_TEST)
    .all(
      idFloor(now - SHARED_WINDOW_MS - QUEUED_SLACK_MS),
      new Date(now - SHARED_WINDOW_MS).toISOString(),
      repoId,
      NO_TEST_NAME,
    );
}

/**
 * Whether a failed check fails only what the lane fails: it named at least
 * one test, and every one was failed by {@link SHARED_PULLS} or more pulls
 * (this one counted, once it is recorded) in the window. A check that named
 * nothing, or one test few others fail, is the pull's own.
 */
export function sharedWithPulls(
  db: Database,
  run: Pick<Run, "repoId" | "checkDetail"> | undefined,
  now: number = Date.now(),
): boolean {
  const names = run?.checkDetail?.names ?? [];
  if (run === undefined || names.length === 0) return false;
  const pulls = new Map(pullsPerTest(db, now, run.repoId).map((r) => [r.test, r.pulls]));
  return names.every((n) => (pulls.get(n) ?? 0) >= SHARED_PULLS);
}

/** Every shared test across the forge's repositories, oldest first: one query. */
export function sharedTests(db: Database, now: number = Date.now()): SharedTest[] {
  return pullsPerTest(db, now, null)
    .filter((r) => r.pulls >= SHARED_PULLS)
    .sort((a, b) => a.since.localeCompare(b.since))
    .map((r) => ({ repoId: r.repo_id, repo: r.repo, test: r.test, pulls: r.pulls, since: r.since }));
}

/**
 * The vitals cause for one shared test: `shared:<repoId>:<hash>`, stable
 * for the test, short enough that the sentinel's finding key
 * ({@link flakeKey}) keeps all of it.
 */
export function sharedCause(t: Pick<SharedTest, "repoId" | "test">): string {
  return `shared:${t.repoId}:${Bun.hash(t.test).toString(36).slice(0, 10)}`;
}

/**
 * The sentinel's finding key for a cause, `degraded:${keyPart(cause)}`
 * (`crew/sentinel.ts`, which reads the vitals and so is not imported here):
 * a shared cause is already lowercase base32 and base36, so only `:` moves.
 */
export const flakeKey = (cause: string): string => `degraded:${cause.replaceAll(":", "-")}`;

/**
 * Where the card points: the open flake issue the sentinel filed for this
 * test, to follow it, else the repository's new-issue page, to file one.
 */
export function flakeHref(db: Database, t: SharedTest): string {
  const filed = db
    .query<{ repo: string; number: number }, [string]>(
      `SELECT u.username || '/' || repo.name AS repo, i.number
         FROM sentinel_finding f
         JOIN issue i ON i.id = f.issue_id
         JOIN repo ON repo.id = i.repo_id
         JOIN user u ON u.id = repo.owner_id
        WHERE f.key = ?1 AND i.state = 'open'
        LIMIT 1`,
    )
    .get(flakeKey(sharedCause(t)));
  return filed === null ? `/${t.repo}/issues/new` : `/${filed.repo}/issues/${filed.number}`;
}

/** The card's sentence: which test, on how many pulls, and that they wait. */
export function sharedSentence(t: SharedTest): string {
  return `${t.repo}: "${t.test}" failed on ${t.pulls} pulls in the last hour — the lane's red, not theirs; they wait for main's next green check, unparked.`;
}
