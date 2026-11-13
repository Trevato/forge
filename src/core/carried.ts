/**
 * Carried — which merged pulls a production deploy carries.
 *
 * What a deploy carries is a fact of git: the merged pulls of its repository
 * whose merge commit its commit contains, one `git rev-list` away. It is
 * never stored per deploy. What the forge keeps (`deploy_landed`, one row per
 * merged pull) is the one answer a page needs often and git cannot give
 * cheaply: when each pull FIRST went live — the first successful production
 * deploy that contained it. When a production deploy finishes, the walk runs
 * once and only the pulls no earlier deploy had carried are written
 * (`recordCarried`): a handful of rows however many pulls the deploy carries.
 *
 * The first form wrote one `deploy_pull` row per pull per deploy (about 2,500
 * rows for each of the ~650 deploys a week of the forge's own repository, 9.9M
 * rows and 2.2 GB on production). Nothing writes that table now; the run page,
 * the run API and the deploys screen read it while its rows last and otherwise
 * walk git (`carriedFor`), and `backfillLanded` fills the new table from the
 * old rows for the deploys of the ask-to-live window. `system/retention_deploys.ts`
 * trims the old rows in slices; the table is dropped in a later release.
 */

import type { Database } from "bun:sqlite";
import { runLocal } from "../git/local.ts";

const FULL_OID = /^[0-9a-f]{40,64}$/;
/** Most commits one walk reads; past this a deploy records what it saw. */
const WALK_MAX = 200_000;

/** The merged pulls whose merge commit is in this set, as issue numbers. */
function mergedAmong(
  db: Database,
  repoId: string,
  contained: ReadonlySet<string>,
): { issueId: string; number: number; mergedOid: string }[] {
  return db
    .query<{ issueId: string; number: number; mergedOid: string }, [string]>(
      `SELECT issue.id AS issueId, issue.number AS number, pull.merged_oid AS mergedOid
         FROM issue JOIN pull ON pull.issue_id = issue.id
        WHERE issue.repo_id = ?1 AND pull.merged_at IS NOT NULL
          AND pull.merged_oid IS NOT NULL AND pull.merged_oid != ''
        ORDER BY issue.number`,
    )
    .all(repoId)
    .filter((row) => contained.has(row.mergedOid));
}

/**
 * Record what a finished production deploy first put live: the merged pulls
 * `commitOid` contains that no earlier deploy carried (a pull an earlier
 * deploy carried keeps that deploy's row). Returns every pull the commit
 * carries, by number, as before; a commit git cannot walk records nothing.
 * Recording twice is the same as once.
 */
export async function recordCarried(
  db: Database,
  input: CarriedInput,
): Promise<number[]> {
  const carried = await containedPulls(db, input);
  if (carried === undefined) return [];
  land(db, input.runId, carried);
  return carried.map((p) => p.number);
}

interface CarriedInput {
  runId: string;
  repoId: string;
  commitOid: string;
  /** The repository's directory. */
  dir: string;
}

interface Contained {
  issueId: string;
  number: number;
  mergedOid: string;
}

/**
 * The merged pulls `commitOid` contains, or undefined when git could not
 * walk the commit, so a caller can tell a failed walk from "carries none".
 */
async function containedPulls(db: Database, input: CarriedInput): Promise<Contained[] | undefined> {
  if (!FULL_OID.test(input.commitOid)) return [];
  const walked = await runLocal(
    ["rev-list", `--max-count=${WALK_MAX}`, input.commitOid],
    { cwd: input.dir },
  );
  if (!walked.ok) return undefined;
  const contained = new Set(walked.value.split("\n").filter((l) => l !== ""));
  return mergedAmong(db, input.repoId, contained);
}

/**
 * Write `deploy_landed` for the pulls this run is the first to carry (or
 * carried earlier than the run that holds them: a deploy recorded late).
 * One read of the pulls' rows and one transaction of the few that need one.
 */
function land(db: Database, runId: string, carried: readonly Contained[]): void {
  if (carried.length === 0) return;
  const at =
    db
      .query<{ at: string | null }, [string]>(
        "SELECT COALESCE(serving_at, finished_at) AS at FROM run WHERE id = ?1",
      )
      .get(runId)?.at ?? new Date().toISOString();
  const have = new Map(
    db
      .query<{ issue_id: string; at: string }, [string]>(
        "SELECT issue_id, at FROM deploy_landed WHERE issue_id IN (SELECT value FROM json_each(?1))",
      )
      .all(JSON.stringify(carried.map((p) => p.issueId)))
      .map((row) => [row.issue_id, row.at] as const),
  );
  const fresh = carried.filter((p) => {
    const earlier = have.get(p.issueId);
    return earlier === undefined || at < earlier;
  });
  if (fresh.length === 0) return;
  const put = db.query(
    `INSERT INTO deploy_landed (issue_id, run_id, pull_number, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(issue_id) DO UPDATE SET run_id = excluded.run_id, at = excluded.at
      WHERE excluded.at < deploy_landed.at`,
  );
  db.transaction(() => {
    for (const p of fresh) put.run(p.issueId, runId, p.number, at);
  })();
}

/** Pulls one slice of `backfillLanded` reads at most. */
export const LANDED_SLICE = 60;
/** Deploys a pull probes from its merge on before it reads its own rows (the first one tried almost always carries it). */
const PROBES = 4;

/**
 * Fill `deploy_landed` from the old per-deploy rows (`deploy_pull`), for the
 * pulls merged since `since` (the ask-to-live window) that have no row yet:
 * for each, the first successful production deploy at or after its merge that
 * carries it. A slice reads at most `cap` pulls, in merge order after
 * `after` (a cursor: a pull no deploy carries yet is read again by the next
 * pass, not by the next slice), and says where the next one starts; `next`
 * is undefined when the pass is over. Writing what a deploy first carried is
 * `INSERT OR IGNORE`-shaped: a repeat is the same as once. A deploy the old
 * rows never had (a pull no row names) records nothing, and the next
 * deploy that carries it records it itself (`recordCarried`).
 */
export function backfillLanded(
  db: Database,
  since: string,
  cap: number = LANDED_SLICE,
  after: { at: string; id: string } = { at: "", id: "" },
): { filled: number; next: { at: string; id: string } | undefined } {
  const pulls = db
    .query<{ id: string; repo_id: string; number: number; at: string }, [string, string, string, number]>(
      `SELECT i.id, i.repo_id, i.number, p.merged_at AS at
         FROM pull p INDEXED BY pull_merged CROSS JOIN issue i ON i.id = p.issue_id
        WHERE p.merged_at >= ?1 AND (p.merged_at, i.id) > (?2, ?3)
          AND NOT EXISTS (SELECT 1 FROM deploy_landed l WHERE l.issue_id = i.id)
        ORDER BY p.merged_at, i.id LIMIT ?4`,
    )
    .all(since, after.at, after.id, Math.max(1, Math.floor(cap)));
  if (pulls.length === 0) return { filled: 0, next: undefined };
  const deploys = db.query<{ id: string; at: string }, [string, string, number]>(
    `SELECT id, COALESCE(serving_at, finished_at) AS at FROM run INDEXED BY run_deploy_live_at
      WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production' AND state = 'ok'
        AND COALESCE(serving_at, finished_at) >= ?2
      ORDER BY 2, id LIMIT ?3`,
  );
  const carries = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM deploy_pull WHERE run_id = ?1 AND issue_id = ?2",
  );
  const rest = db.query<{ id: string | null; at: string | null }, [string, string, string]>(
    `SELECT r.id AS id, COALESCE(r.serving_at, r.finished_at) AS at
       FROM deploy_pull dp CROSS JOIN run r ON r.id = dp.run_id
      WHERE dp.issue_id = ?3 AND r.repo_id = ?1 AND r.kind = 'deploy'
        AND r.env = 'production' AND r.state = 'ok'
        AND COALESCE(r.serving_at, r.finished_at) >= ?2
      ORDER BY 2, r.id LIMIT 1`,
  );
  const put = db.query(
    `INSERT INTO deploy_landed (issue_id, run_id, pull_number, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(issue_id) DO UPDATE SET run_id = excluded.run_id, at = excluded.at
      WHERE excluded.at < deploy_landed.at`,
  );
  let filled = 0;
  db.transaction(() => {
    for (const pull of pulls) {
      let first: { id: string; at: string } | undefined;
      for (const d of deploys.all(pull.repo_id, pull.at, PROBES)) {
        if (carries.get(d.id, pull.id) !== null) {
          first = d;
          break;
        }
      }
      if (first === undefined) {
        const found = rest.get(pull.repo_id, pull.at, pull.id);
        if (found?.id != null && found.at != null) first = { id: found.id, at: found.at };
      }
      if (first === undefined) continue;
      put.run(pull.id, first.id, pull.number, first.at);
      filled++;
    }
  })();
  const last = pulls[pulls.length - 1]!;
  return {
    filled,
    next: pulls.length < Math.max(1, Math.floor(cap)) ? undefined : { at: last.at, id: last.id },
  };
}

/** The pull numbers a deploy run carries, ascending. */
export function carriedBy(db: Database, runId: string): number[] {
  return db
    .query<{ pull_number: number }, [string]>(
      "SELECT pull_number FROM deploy_pull WHERE run_id = ?1 ORDER BY pull_number",
    )
    .all(runId)
    .map((row) => row.pull_number);
}

/** A deploy run as `carriedFor` reads it. */
export interface CarriedRun {
  readonly id: string;
  readonly repoId: string;
  readonly kind: string;
  readonly env: string;
  readonly state: string;
  readonly commitOid: string;
}

/** How long a walk git could not finish is not retried (a broken repo is not walked per view). */
export const WALK_FAILED_MS = 60_000;
/** Most runs remembered as carrying none, per database; the oldest goes first. */
const EMPTY_MAX = 10_000;
/** Most walked lists remembered, per database; the oldest goes first (a list is up to a few thousand numbers). */
const LISTS_MAX = 200;

/**
 * Per database: the walks under way, by run (two views of one run share
 * one walk), the lists walks found (a finished deploy's commit and the pulls
 * merged before it do not change, so a list stays right), and the runs a walk
 * found carrying none (until when, in ms; Infinity for a finished walk, a
 * failed one for `WALK_FAILED_MS`). Nothing a walk finds is written to the
 * database: a deploy's whole list is a fact git gives in one walk, not a
 * table's rows.
 */
const walking = new WeakMap<Database, Map<string, Promise<number[]>>>();
const carriesNone = new WeakMap<Database, Map<string, number>>();
const walked = new WeakMap<Database, Map<string, number[]>>();

const rebuildable = (run: CarriedRun): boolean =>
  run.kind === "deploy" && run.env === "production" && run.state === "ok";

/**
 * The walk of one deploy that has no rows: made at most once at a time, and
 * not again once it found a list or none.
 */
function rebuild(db: Database, run: CarriedRun, dir: string): Promise<number[]> {
  const lists = walked.get(db) ?? new Map<string, number[]>();
  walked.set(db, lists);
  const known = lists.get(run.id);
  if (known !== undefined) return Promise.resolve(known);
  const none = carriesNone.get(db) ?? new Map<string, number>();
  carriesNone.set(db, none);
  const until = none.get(run.id);
  if (until !== undefined) {
    if (until > performance.now()) return Promise.resolve([]);
    none.delete(run.id);
  }
  const flights = walking.get(db) ?? new Map<string, Promise<number[]>>();
  walking.set(db, flights);
  const inFlight = flights.get(run.id);
  if (inFlight !== undefined) return inFlight;
  const walk = containedPulls(db, { runId: run.id, repoId: run.repoId, commitOid: run.commitOid, dir })
    .then((found) => {
      if (found === undefined || found.length === 0) {
        none.set(run.id, found === undefined ? performance.now() + WALK_FAILED_MS : Infinity);
        if (none.size > EMPTY_MAX) none.delete(none.keys().next().value!);
        return [];
      }
      const list = found.map((p) => p.number);
      lists.set(run.id, list);
      if (lists.size > LISTS_MAX) lists.delete(lists.keys().next().value!);
      return list;
    })
    .finally(() => flights.delete(run.id));
  flights.set(run.id, walk);
  return walk;
}

/**
 * The pull numbers a deploy run carries, as pages read them: the rows an
 * older release recorded while retention (`system/retention_deploys.ts`)
 * has not trimmed them, or — for a finished production deploy with none —
 * the list walked from git now and kept in memory. A deploy that carries none
 * is walked once per process, and concurrent views of one run share a walk.
 * `dir` is the repository's directory.
 */
export async function carriedFor(db: Database, run: CarriedRun, dir: string): Promise<number[]> {
  const recorded = carriedBy(db, run.id);
  if (recorded.length > 0 || !rebuildable(run)) return recorded;
  return rebuild(db, run, dir);
}

/**
 * `carriedByRuns` for a list of deploys, with each trimmed one rebuilt as
 * `carriedFor` does (one at a time, the same single walk per run). Runs that
 * carry none are absent.
 */
export async function carriedForRuns(
  db: Database,
  runs: readonly CarriedRun[],
  dir: string,
): Promise<Map<string, number[]>> {
  const found = carriedByRuns(db, runs.map((r) => r.id));
  for (const run of runs) {
    if (found.has(run.id) || !rebuildable(run)) continue;
    const rebuilt = await rebuild(db, run, dir);
    if (rebuilt.length > 0) found.set(run.id, rebuilt);
  }
  return found;
}

/** The pull numbers each of these runs carries, in one read; runs that carry none are absent. */
export function carriedByRuns(
  db: Database,
  runIds: readonly string[],
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  if (runIds.length === 0) return found;
  const rows = db
    .query<{ run_id: string; pull_number: number }, string[]>(
      `SELECT run_id, pull_number FROM deploy_pull
        WHERE run_id IN (${runIds.map((_, i) => `?${i + 1}`).join(",")})
        ORDER BY run_id, pull_number`,
    )
    .all(...runIds);
  for (const row of rows) {
    const list = found.get(row.run_id) ?? [];
    list.push(row.pull_number);
    found.set(row.run_id, list);
  }
  return found;
}

/** `carries #3 #5`, or nothing when a deploy carries no pull. */
export function carriesText(numbers: readonly number[]): string {
  return numbers.length === 0 ? "" : `carries ${numbers.map((n) => `#${n}`).join(" ")}`;
}
