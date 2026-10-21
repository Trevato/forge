/**
 * A red main pauses its pulls' checks (#1797). While the default branch's
 * own last check failed, every pull's check fails the same case for a reason
 * none of them caused — 21 heads failed one test in 0.3 h, each sent back to
 * its agent. So a pull's check of that repository waits, queued, until main
 * is green again; main's own checks keep running, and the vitals carry one
 * card naming the failing test in place of a failure per pull.
 *
 * The fix for a red main comes through a pull, and that pull must be able
 * to show green, so the hold is bounded twice: a pull a person asks to
 * check (`checks/again.ts`, reason `asked`) is not held, and no check is
 * held past {@link RED_HOLD_MS} after it was queued. The service holds only
 * when told how long (`ChecksOptions.redHoldMs`); the forge's `main.ts`
 * says this.
 *
 * Plain data: the last finished check of each default branch, read by the
 * `run_repo` index, one query whoever asks.
 */

import type { Database } from "bun:sqlite";
import type { Run } from "../core/runs.ts";

export interface RedMain {
  readonly repoId: string;
  /** `owner/name`, for the card. */
  readonly repo: string;
  readonly runId: string;
  readonly commitOid: string;
  /** The failing tests' names the check recorded, else its summary. */
  readonly failing: readonly string[];
  readonly summary: string;
  /** The repository's default branch, for the link to its forge.json. */
  readonly branch: string;
  /** The check was stopped by its cell's limit or its budget, not by a test: no pull shares it. */
  readonly limit: boolean;
  readonly since: string;
}

/** The reason a person's own ask carries; it runs while main is red. */
export const ASKED = "asked";

/** The longest a red main holds a pull's check before it runs anyway. */
export const RED_HOLD_MS = 20 * 60_000;

interface Row {
  id: string;
  repo_id: string;
  repo: string;
  branch: string;
  commit_oid: string;
  state: string;
  summary: string;
  check_detail: string;
  finished_at: string | null;
  created_at: string;
}

/**
 * The repository's red main, if its default branch's last finished check
 * failed. A check cancelled or still running says nothing either way.
 */
export function redMain(db: Database, repoId: string): RedMain | undefined {
  const row = db.query<Row, [string]>(lastMain("SELECT ?1 AS repo_id")).get(repoId);
  return row === null ? undefined : toRed(row);
}

/**
 * The last finished check of the default branch of each repository `from`
 * names (a query answering `repo_id`),
 * joined to its owner for the card. A constant of this module, never input.
 */
const lastMain = (from: string): string => `
  SELECT run.id, run.repo_id, run.commit_oid, run.state, run.summary,
         run.check_detail, run.finished_at, run.created_at,
         u.username || '/' || repo.name AS repo, repo.default_branch AS branch
    FROM (${from}) l
    JOIN repo ON repo.id = l.repo_id
    JOIN user u ON u.id = repo.owner_id
    JOIN run ON run.id = (
      SELECT r.id FROM run r
       WHERE r.repo_id = l.repo_id AND r.kind = 'check'
         AND r.issue_id IS NULL AND r.env = repo.default_branch
         AND r.state IN ('ok', 'failed')
       ORDER BY r.id DESC LIMIT 1)`;

/** A summary of a cell stop (`apps/contain.ts`) or a budget kill (`kernel/budgets.ts`). */
const LIMIT = /^(?:check failed: )?(?:stopped: |budget:)/;

function toRed(row: Row): RedMain | undefined {
  if (row.state !== "failed") return undefined;
  let failing: string[] = [];
  try {
    const detail = row.check_detail ? (JSON.parse(row.check_detail) as { names?: unknown }) : {};
    if (Array.isArray(detail.names))
      failing = detail.names.filter((n): n is string => typeof n === "string");
  } catch {
    failing = [];
  }
  return {
    repoId: row.repo_id,
    repo: row.repo,
    runId: row.id,
    commitOid: row.commit_oid,
    failing,
    summary: row.summary,
    branch: row.branch,
    limit: LIMIT.test(row.summary),
    since: row.finished_at ?? row.created_at,
  };
}

/** Whether a red main still holds `run`: a pull's check, not asked for, queued under `holdMs` ago. */
export function heldByRed(
  run: Pick<Run, "kind" | "issueId" | "reason" | "createdAt">,
  red: RedMain | undefined,
  holdMs: number,
  now: number,
): boolean {
  return (
    red !== undefined &&
    !red.limit &&
    run.kind === "check" &&
    run.issueId !== null &&
    run.reason !== ASKED &&
    now - Date.parse(run.createdAt) < holdMs
  );
}

/**
 * Which queued checks may start: all but the pull checks a red main holds.
 * `red` is asked once per repository among `queued`, and not at all when
 * nothing is held (`holdMs` 0).
 */
export function unheld(
  queued: readonly Run[],
  red: (repoId: string) => RedMain | undefined,
  holdMs: number,
  now: number = Date.now(),
): Run[] {
  if (holdMs <= 0) return [...queued];
  const seen = new Map<string, RedMain | undefined>();
  return queued.filter((run) => {
    if (run.issueId === null || run.reason === ASKED) return true;
    if (!seen.has(run.repoId)) seen.set(run.repoId, red(run.repoId));
    return !heldByRed(run, seen.get(run.repoId), holdMs, now);
  });
}

/** Pull checks queued, not asked for, per repository: `n` of them. Read by `run_queue`. */
const HELD = `
  SELECT repo_id, COUNT(*) AS n FROM run
   WHERE state = 'queued' AND kind = 'check'
     AND issue_id IS NOT NULL AND reason <> '${ASKED}'
   GROUP BY repo_id`;

/**
 * Each red main with pull checks waiting on it, and how many wait: one
 * query. A check waiting past the hold is still counted until it runs. A main
 * stopped by a limit holds nothing, so it has no card.
 */
export function heldChecks(db: Database): { red: RedMain; held: number }[] {
  const rows = db
    .query<Row & { n: number }, []>(
      `SELECT last.*, h.n FROM (${lastMain(HELD)}) last
         JOIN (${HELD}) h ON h.repo_id = last.repo_id
        WHERE last.state = 'failed'`,
    )
    .all();
  const out: { red: RedMain; held: number }[] = [];
  for (const row of rows) {
    const red = toRed(row);
    if (red !== undefined && !red.limit) out.push({ red, held: row.n });
  }
  return out;
}

/** A main that was red and is green again: when its last red and its green finished. */
export interface Release {
  readonly redAt: string;
  readonly greenAt: string;
}

/**
 * The id of `q`'s repository's last finished default-branch check, older
 * than `below` when given: a constant of this module, never input.
 */
const mainBefore = (below: string): string => `(
  SELECT r.id FROM run r JOIN repo m ON m.id = r.repo_id
   WHERE r.repo_id = q.repo_id AND r.kind = 'check'
     AND r.issue_id IS NULL AND r.env = m.default_branch
     AND r.state IN ('ok', 'failed') ${below}
   ORDER BY r.id DESC LIMIT 1)`;

/** The last two finished main checks, as `toRelease` reads them. */
interface ReleaseRow {
  last_state: string | null;
  green_at: string | null;
  prev_state: string | null;
  prev_summary: string | null;
  red_at: string | null;
}

/**
 * The repository's last turn from red to green: its default branch's last
 * finished check passed and the one before it failed by a test (a limit
 * holds nothing, so releases nothing).
 */
function toRelease(row: ReleaseRow): Release | undefined {
  if (
    row.last_state !== "ok" ||
    row.prev_state !== "failed" ||
    LIMIT.test(row.prev_summary ?? "") ||
    row.green_at === null ||
    row.red_at === null
  )
    return undefined;
  return { redAt: row.red_at, greenAt: row.green_at };
}

/**
 * Since when a queued check has waited for the lane (#3946): its queue time,
 * unless the last red main held it — then the moment the hold ended, at the
 * green or at `holdMs` after it was queued, whichever came first. Fourteen
 * checks a red main held for twenty minutes, freed at once by the green,
 * have not waited twenty minutes behind the lane.
 */
export function laneSince(
  run: { readonly issueId: string | null; readonly reason: string; readonly createdAt: string },
  release: Release | undefined,
  holdMs: number,
): string {
  if (release === undefined || run.issueId === null || run.reason === ASKED) return run.createdAt;
  const queued = Date.parse(run.createdAt);
  const green = Date.parse(release.greenAt);
  // Queued after the green, or its hold over before the red: never held.
  if (queued >= green || queued + holdMs <= Date.parse(release.redAt)) return run.createdAt;
  return new Date(Math.min(green, queued + holdMs)).toISOString();
}

/**
 * The queued checks no red main holds (startable now): how many, and the
 * oldest one's `laneSince`. A held check's age says nothing about the lane,
 * and nor does the time a released one spent held.
 */
export function freeChecks(
  db: Database,
  redRepoIds: readonly string[],
  now: number,
  holdMs: number = RED_HOLD_MS,
): { n: number; oldest: string | null } {
  const rows = db
    .query<ReleaseRow & { issue_id: string | null; reason: string; created_at: string }, [string, string]>(
      `SELECT q.issue_id, q.reason, q.created_at,
              last.state AS last_state, last.finished_at AS green_at,
              prev.state AS prev_state, prev.summary AS prev_summary, prev.finished_at AS red_at
         FROM run q
         LEFT JOIN run last ON last.id = ${mainBefore("")}
         LEFT JOIN run prev ON prev.id = ${mainBefore("AND r.id < last.id")}
        WHERE q.state = 'queued' AND q.kind = 'check'
          AND (q.not_before IS NULL OR q.not_before <= ?1)
          AND NOT (q.issue_id IS NOT NULL AND q.reason <> '${ASKED}'
                   AND q.repo_id IN (SELECT value FROM json_each(?2)))`,
    )
    .all(new Date(now).toISOString(), JSON.stringify(redRepoIds));
  let oldest: string | null = null;
  for (const row of rows) {
    const since = laneSince(
      { issueId: row.issue_id, reason: row.reason, createdAt: row.created_at },
      toRelease(row),
      holdMs,
    );
    if (oldest === null || Date.parse(since) < Date.parse(oldest)) oldest = since;
  }
  return { n: rows.length, oldest };
}

/**
 * The manifest error a check failed on before any test ran
 * (`apps/manifest.ts`), else undefined: such a check is the repository's own
 * to fix, not a failing test.
 */
export function manifestError(red: RedMain): string | undefined {
  const text = red.summary.replace(/^check failed: /, "");
  return red.failing.length === 0 && text.startsWith("forge.json: ") ? text : undefined;
}

/** Where a red main's card points: its forge.json when that is invalid, else the run. */
export function redHref(red: RedMain): string {
  return manifestError(red) === undefined
    ? `/${red.repo}/runs/${red.runId}`
    : `/${red.repo}/blob/${encodeURIComponent(red.branch)}/forge.json`;
}

/** The card's sentence: what is red, by which test, and what waits. */
export function redSentence(red: RedMain, held: number): string {
  const bad = manifestError(red);
  if (bad !== undefined)
    return `${red.repo}: the forge.json on main (${red.commitOid.slice(0, 7)}) is invalid, so no check can run — "${bad.slice(0, 200)}"; fix forge.json (${redHref(red)}); ${held} pull check${held === 1 ? "" : "s"} wait for it.`;
  const first = red.failing[0];
  const what =
    first === undefined
      ? red.summary.replace(/^check failed: /, "")
      : red.failing.length === 1
        ? `"${first}" fails`
        : `"${first}" and ${red.failing.length - 1} more fail`;
  return `${red.repo}: main is red at ${red.commitOid.slice(0, 7)} — ${what}; ${held} pull check${held === 1 ? "" : "s"} wait for it to pass.`;
}

/**
 * Whether a failed check fails only what main's last check already fails
 * (#1971): it named at least one test, and every one is red on main too.
 * Such a failure is not the pull's, so the crew neither reworks nor parks
 * it; it waits for main to be green. A check that named nothing (a build
 * error, a timeout) or one test main does not fail is the pull's own.
 */
export function sharedWithMain(red: RedMain | undefined, run: Pick<Run, "checkDetail"> | undefined): boolean {
  const names = run?.checkDetail?.names ?? [];
  return red !== undefined && names.length > 0 && names.every((n) => red.failing.includes(n));
}
