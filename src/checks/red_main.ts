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
         u.username || '/' || repo.name AS repo
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

/** The card's sentence: what is red, by which test, and what waits. */
export function redSentence(red: RedMain, held: number): string {
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
