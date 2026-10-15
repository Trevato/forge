/**
 * Carried — which merged pulls a production deploy carries.
 *
 * When a production deploy finishes, one `git rev-list` of its commit says
 * which commits it contains; every merged pull of the repository whose
 * merge commit is among them is recorded against the run. A pull merged
 * after the deployed commit is not in the walk, so it is not recorded. The
 * table is an index over git (`deploy_pull`): rebuilding it is running this
 * again for the deploy.
 */

import type { Database } from "bun:sqlite";
import { runLocal } from "../git/local.ts";
import { repoDir } from "../git/repos.ts";
import { PILLAR_DAYS } from "./pillars.ts";
import { getRepoById } from "./repos.ts";

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
 * Record the merged pulls `commitOid` contains against a finished
 * production deploy. Returns their numbers; a commit git cannot walk
 * records nothing. Recording twice is the same as once.
 */
export async function recordCarried(
  db: Database,
  input: {
    runId: string;
    repoId: string;
    commitOid: string;
    /** The repository's directory. */
    dir: string;
  },
): Promise<number[]> {
  if (!FULL_OID.test(input.commitOid)) return [];
  const walked = await runLocal(
    ["rev-list", `--max-count=${WALK_MAX}`, input.commitOid],
    { cwd: input.dir },
  );
  if (!walked.ok) return [];
  const contained = new Set(walked.value.split("\n").filter((l) => l !== ""));
  const carried = mergedAmong(db, input.repoId, contained);
  const insert = db.query(
    `INSERT OR IGNORE INTO deploy_pull (run_id, issue_id, pull_number, merged_oid)
     VALUES (?1, ?2, ?3, ?4)`,
  );
  db.transaction(() => {
    for (const p of carried)
      insert.run(input.runId, p.issueId, p.number, p.mergedOid);
  })();
  return carried.map((p) => p.number);
}

/**
 * Record what earlier production deploys carried, for the deploys of the
 * ask-to-live window that have no record yet (they finished before deploys
 * wrote one). A boot step, never a page view; a deploy that carries nothing
 * is walked again on each boot, bounded by the window. Returns how many
 * deploys it recorded something for.
 */
export async function backfillCarried(
  db: Database,
  reposRoot: string,
  now = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - PILLAR_DAYS * 86_400_000).toISOString();
  const runs = db
    .query<{ id: string; repoId: string; oid: string }, [string]>(
      `SELECT id, repo_id AS repoId, commit_oid AS oid FROM run
        WHERE kind = 'deploy' AND env = 'production' AND state = 'ok' AND commit_oid != ''
          AND COALESCE(serving_at, finished_at) >= ?1
          AND NOT EXISTS (SELECT 1 FROM deploy_pull WHERE run_id = run.id)
        ORDER BY COALESCE(serving_at, finished_at)`,
    )
    .all(since);
  let recorded = 0;
  for (const run of runs) {
    const repo = getRepoById(db, run.repoId);
    if (repo === undefined) continue;
    const dir = repoDir(reposRoot, repo.ownerName, repo.name);
    const carried = await recordCarried(db, {
      runId: run.id,
      repoId: run.repoId,
      commitOid: run.oid,
      dir,
    });
    if (carried.length > 0) recorded++;
  }
  return recorded;
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
