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

/**
 * Suites that are gates on the tree itself (#2868): each reads the source and
 * fails the pull that added the thing it forbids, the same way on any
 * machine. Many pulls tripping one in an hour is many pulls each adding
 * what it forbids (a class DESIGN.md does not name), not a lane's red, so they never make one.
 * A name here is a suite's `describe` prefix, or one test's full name when
 * the rest of its suite is not a gate, and a test keeps it existing.
 * Reserved names (#7809): each pull adding a top-level page without
 * reserving it ("keeper", "feed", "favicon.ico") failed it, main green.
 * OpenAPI coverage (#8140): each pull adding an /api/v1 route without its
 * row, or a route file without regenerating the index, failed it, main green.
 * MCP tools (#7906): each pull adding a tool without `bun scripts/mcp-tools.ts`
 * failed the index check, main green.
 * The rest are top-level tests named whole (#8184): each reads only the tree.
 */
export const TREE_GATES: readonly string[] = [
  "design check: nothing added outside the system (#2678) > ",
  "no polling in src/web > ",
  "reserved names > every top-level page of the forge is a reserved name",
  // A route a pull added without its row in docs/openapi.
  "every registered /api/v1 route has an OpenAPI row or is listed as not yet described",
  "NOT_YET_DESCRIBED has no entry that is now described",
  "NOT_YET_DESCRIBED is sorted and names registered routes",
  // An import a pull added from scripts/ or test/ into src/.
  "nothing under src/ imports from outside src/ (scripts/, test/, …)",
  // A README a pull grew past its limit, or a docs/ link it broke.
  "README.md stays under 80 KB",
  "every docs/ link in README.md resolves",
  // A route file a pull added without regenerating the index.
  "the gathered routes > the index is current: run `bun scripts/openapi-routes.ts`",
  // A tool file a pull added without regenerating the index (#7906).
  "the gathered tools > the index is current: run `bun scripts/mcp-tools.ts`",
];

/** Whether a failing test's name is one of {@link TREE_GATES}': under a suite prefix (`… > `), or a test's full name exactly. */
export const isTreeGate = (test: string): boolean =>
  TREE_GATES.some((g) => (g.endsWith(" > ") ? test.startsWith(g) : test === g));

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
     AND n.type = 'text' AND instr(n.value, ?4) = 0
   GROUP BY run.repo_id, n.value`;

function pullsPerTest(db: Database, now: number, repoId: string | null): Row[] {
  return db
    .query<Row, [string, string, string | null, string]>(PULLS_PER_TEST)
    .all(
      idFloor(now - SHARED_WINDOW_MS - QUEUED_SLACK_MS),
      new Date(now - SHARED_WINDOW_MS).toISOString(),
      repoId,
      NO_TEST_NAME,
    )
    .filter((r) => !isTreeGate(r.test));
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
 * Distinct pulls whose check, created at or after `sinceMs`, failed the test
 * a shared cause names (#8185): the reds a fix that landed then did not end,
 * where the hour's window still holds the ones from before it.
 */
const FAILED_SINCE = `
  SELECT DISTINCT run.issue_id, n.value AS test
    FROM run,
         json_each(CASE WHEN json_valid(run.check_detail) THEN run.check_detail ELSE '{}' END, '$.names') n
   WHERE run.repo_id = ?1 AND run.id >= ?2 AND run.created_at >= ?3
     AND run.kind = 'check' AND run.issue_id IS NOT NULL AND run.state = 'failed'
     AND n.type = 'text'`;

export function pullsFailedSince(db: Database, cause: string, sinceMs: number): number {
  const repoId = cause.split(":")[1] ?? "";
  const rows = db
    .query<{ issue_id: string; test: string }, [string, string, string]>(FAILED_SINCE)
    .all(repoId, idFloor(sinceMs), new Date(sinceMs).toISOString());
  return new Set(rows.filter((r) => sharedCause({ repoId, test: r.test }) === cause).map((r) => r.issue_id)).size;
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

/** One failed pull check on a shared test: which pull, which run, what base it merged. */
export interface SharedRun {
  readonly runId: string;
  readonly pull: number;
  readonly baseOid: string;
}

/** How many of a shared test's failed checks a finding names (#8286). */
export const SHARED_RUNS_NAMED = 5;

/**
 * The failed pull checks in the window on the test a shared cause names,
 * newest first, at most {@link SHARED_RUNS_NAMED} (#8286): what a builder
 * needs to find the log and reproduce the red. Undefined when none is left.
 */
const FAILED_RUNS = `
  SELECT run.id AS run_id, i.number AS pull, run.base_oid AS base_oid, n.value AS test
    FROM run
    JOIN issue i ON i.id = run.issue_id,
         json_each(CASE WHEN json_valid(run.check_detail) THEN run.check_detail ELSE '{}' END, '$.names') n
   WHERE run.repo_id = ?1 AND run.id >= ?2 AND run.finished_at >= ?3
     AND run.kind = 'check' AND run.state = 'failed' AND n.type = 'text'
   ORDER BY run.id DESC`;

export function sharedRuns(
  db: Database,
  cause: string,
  now: number = Date.now(),
): { test: string; runs: SharedRun[] } | undefined {
  const repoId = cause.split(":")[1] ?? "";
  const rows = db
    .query<{ run_id: string; pull: number; base_oid: string; test: string }, [string, string, string]>(FAILED_RUNS)
    .all(repoId, idFloor(now - SHARED_WINDOW_MS - QUEUED_SLACK_MS), new Date(now - SHARED_WINDOW_MS).toISOString())
    .filter((r) => sharedCause({ repoId, test: r.test }) === cause);
  const first = rows[0];
  if (first === undefined) return undefined;
  return {
    test: first.test,
    runs: rows.slice(0, SHARED_RUNS_NAMED).map((r) => ({ runId: r.run_id, pull: r.pull, baseOid: r.base_oid })),
  };
}

/** Main's newest finished check, and whether it failed the named test. */
export function mainVerdict(
  db: Database,
  repoId: string,
  test: string,
): { runId: string; commitOid: string; passes: boolean } | undefined {
  const row = db
    .query<{ id: string; commit_oid: string; state: string; check_detail: string | null }, [string]>(
      `SELECT r.id, r.commit_oid, r.state, r.check_detail FROM run r JOIN repo ON repo.id = r.repo_id
        WHERE r.repo_id = ?1 AND r.kind = 'check' AND r.issue_id IS NULL
          AND r.env = repo.default_branch AND r.state IN ('ok', 'failed')
        ORDER BY r.id DESC LIMIT 1`,
    )
    .get(repoId);
  if (row === null) return undefined;
  let names: unknown = [];
  try {
    names = (JSON.parse(row.check_detail ?? "{}") as { names?: unknown }).names ?? [];
  } catch {
    names = [];
  }
  const failsIt = row.state === "failed" && Array.isArray(names) && names.includes(test);
  return { runId: row.id, commitOid: row.commit_oid, passes: row.state === "ok" || !failsIt };
}

/** The most lines of a failing test's output a finding quotes. */
export const ASSERTION_LINES = 20;

const RESULT = /^\((?:pass|fail|skip|todo)\) /;
const FILE_HEADER = /^\S+\.test\.[cm]?[jt]sx?:$/;
/** bun's closing tally: a `(fail)` line under it is the recap, not the report. */
const TALLY = /^\s*\d+ (?:pass|fail|skip|todo)$|^\d+ tests? failed:$|^Ran \d+ tests? /;

/**
 * What bun printed for one failing test: the lines above its `(fail)` line,
 * back to the result or file header before them, at most
 * {@link ASSERTION_LINES}. The newest report wins; bun's recap of `(fail)`
 * lines under its tally quotes nothing. Empty when no report is in `lines`.
 */
export function assertionLines(lines: readonly string[], test: string): string[] {
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (line !== `(fail) ${test}` && !line.startsWith(`(fail) ${test} [`)) continue;
    let from = at;
    while (from > 0 && at - from < ASSERTION_LINES && !RESULT.test(lines[from - 1]!) && !FILE_HEADER.test(lines[from - 1]!))
      from--;
    const block = lines.slice(from, at);
    if (block.some((l) => TALLY.test(l))) continue;
    const quoted = block.filter((l) => l.trim() !== "");
    if (quoted.length > 0) return quoted;
  }
  return [];
}
