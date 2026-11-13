/**
 * How long main has gone unverified (#7786): for each repository whose
 * main is verified after landing (`checks/verify.ts`), the time since the
 * first landing the last green verification does not cover. /boards'
 * Pipeline card says it, one line per repository, linking the run.
 *
 * "Unverified since" is when the oldest default-branch check after the
 * last green verification's commit was asked for — that commit landed
 * then. Verified at the tip, it is nothing; never verified green, it is
 * since the first verification was asked for.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { getRepoById } from "../core/repos.ts";

export interface VerifiedRow {
  /** `owner/name`. */
  readonly repo: string;
  readonly public: boolean;
  /** When main stopped being verified, or null when its tip is verified green. */
  readonly unverifiedSince: string | null;
  /** The last green verification: its run and commit. */
  readonly green: { readonly runId: string; readonly commitOid: string; readonly at: string } | null;
  /** The newest verification, any state. */
  readonly last: { readonly runId: string; readonly state: string; readonly commitOid: string } | null;
}

interface RunRow {
  id: string;
  commit_oid: string;
  state: string;
  created_at: string;
  finished_at: string | null;
}

/** Each repository with a verification, newest first; private ones for the owner only. */
export function readVerified(app: App, owner: boolean): VerifiedRow[] {
  const ids = app.db
    .query<{ repo_id: string }, []>(
      `SELECT DISTINCT repo_id FROM run INDEXED BY run_check_verify_repo WHERE kind = 'check' AND env = 'verify'`,
    )
    .all();
  const rows: VerifiedRow[] = [];
  for (const { repo_id } of ids) {
    const repo = getRepoById(app.db, repo_id);
    if (repo === undefined || (!owner && repo.visibility !== "public")) continue;
    rows.push(verifiedOf(app.db, repo.id, repo.defaultBranch, `${repo.ownerName}/${repo.name}`, repo.visibility === "public"));
  }
  return rows.sort((a, b) => (a.unverifiedSince ?? "~").localeCompare(b.unverifiedSince ?? "~"));
}

/** One repository's row. */
export function verifiedOf(db: Database, repoId: string, branch: string, name: string, isPublic: boolean): VerifiedRow {
  // A state of "" is any state.
  const verify = (state: string): RunRow | null =>
    db
      .query<RunRow, [string, string]>(
        `SELECT id, commit_oid, state, created_at, finished_at FROM run
          WHERE repo_id = ?1 AND kind = 'check' AND env = 'verify' AND (?2 = '' OR state = ?2)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(repoId, state);
  const green = verify("ok");
  const last = verify("");
  // The newest default-branch check of the green commit; what came after it landed after.
  const covered =
    green === null
      ? null
      : db
          .query<{ id: string }, [string, string, string]>(
            `SELECT MAX(id) AS id FROM run WHERE repo_id = ?1 AND kind = 'check'
               AND issue_id IS NULL AND env = ?2 AND commit_oid = ?3`,
          )
          .get(repoId, branch, green.commit_oid);
  const since =
    green === null
      ? (db
          .query<{ created_at: string }, [string]>(
            `SELECT MIN(created_at) AS created_at FROM run
              WHERE repo_id = ?1 AND kind = 'check' AND env = 'verify'`,
          )
          .get(repoId)?.created_at ?? null)
      : (db
          .query<{ created_at: string }, [string, string, string, string]>(
            `SELECT created_at FROM run WHERE repo_id = ?1 AND kind = 'check' AND issue_id IS NULL
               AND env = ?2 AND id > ?3 AND commit_oid != ?4 ORDER BY id LIMIT 1`,
          )
          .get(repoId, branch, covered?.id ?? green.id, green.commit_oid)?.created_at ?? null);
  return {
    repo: name,
    public: isPublic,
    unverifiedSince: since,
    green: green === null ? null : { runId: green.id, commitOid: green.commit_oid, at: green.finished_at ?? green.created_at },
    last: last === null ? null : { runId: last.id, state: last.state, commitOid: last.commit_oid },
  };
}

const short = (oid: string): string => oid.slice(0, 7);

/** A span in whole minutes under an hour, else hours to one decimal: 7 min, 2.5 h. */
export const spanWords = (ms: number): string =>
  ms < 3_600_000 ? `${Math.floor(Math.max(0, ms) / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

/** The sentence for a row: how long main has gone unverified, and what the last verification said. */
export function verifiedSays(row: VerifiedRow, now: number): string {
  const lastSays =
    row.last === null
      ? ""
      : row.last.state === "ok"
        ? ""
        : row.last.state === "failed"
          ? `; last verification red at ${short(row.last.commitOid)}`
          : row.last.state === "running" || row.last.state === "queued"
            ? `; verifying ${short(row.last.commitOid)} now`
            : "";
  if (row.unverifiedSince === null && row.green !== null)
    return `main verified at ${short(row.green.commitOid)}, ${spanWords(Math.max(0, now - Date.parse(row.green.at)))} ago${lastSays}`;
  const span = row.unverifiedSince === null ? "—" : spanWords(Math.max(0, now - Date.parse(row.unverifiedSince)));
  return row.green === null
    ? `main never verified green, ${span} since the first verification${lastSays}`
    : `main unverified for ${span} since ${short(row.green.commitOid)} was verified green${lastSays}`;
}
