/**
 * An app's open pulls, for a door that cannot draw a page (#6109): number,
 * title, head and the state of the newest check on it, newest first, in one
 * indexed read. Who may see which is the pages' own rule: a repository you
 * cannot read has none, a sealed pull is its author's, a writer's and the
 * crew's, and a suspended account is a guest (`core/sealed.ts`).
 */
import type { Database } from "bun:sqlite";
import { canRead, type Repo } from "../core/repos.ts";
import type { RunState } from "../core/runs.ts";
import { canSeeSealed } from "../core/sealed.ts";
import { isActive, type User } from "../core/users.ts";

export interface DoorPull {
  readonly number: number;
  readonly title: string;
  readonly headOid: string;
  /** The newest check or deploy run of this pull, whatever head it ran. */
  readonly run: { state: RunState; commitOid: string } | undefined;
}

/**
 * ?1 repo, ?2 whether sealed pulls are all visible, ?3 the viewer's id
 * (empty for a guest), ?4 the limit. Walks `issue_repo_kind_number` newest
 * first and stops at the limit; each run is one probe of `run_issue`.
 */
export const OPEN_PULLS_SQL = `
  SELECT i.number AS number, i.title AS title, p.head_oid AS head_oid,
         r.state AS run_state, r.commit_oid AS run_commit
    FROM issue i
    JOIN pull p ON p.issue_id = i.id
    LEFT JOIN run r ON r.id = (
      SELECT id FROM run
       WHERE issue_id = i.id AND kind IN ('deploy','check')
       ORDER BY id DESC LIMIT 1)
   WHERE i.repo_id = ?1 AND i.kind = 'pull' AND i.state = 'open'
     AND (i.sealed = 0 OR ?2 = 1 OR i.author_id = ?3)
   ORDER BY i.number DESC
   LIMIT ?4`;

interface Row {
  number: number;
  title: string;
  head_oid: string;
  run_state: RunState | null;
  run_commit: string | null;
}

export function openPulls(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
  limit = 5,
): DoorPull[] {
  const who = viewer !== undefined && isActive(viewer) ? viewer : undefined;
  if (!canRead(db, repo, who)) return [];
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 0), 50);
  const rows = db
    .query<Row, [string, number, string, number]>(OPEN_PULLS_SQL)
    .all(repo.id, canSeeSealed(db, repo, who) ? 1 : 0, who?.id ?? "", n);
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    headOid: r.head_oid,
    run:
      r.run_state === null
        ? undefined
        : { state: r.run_state, commitOid: r.run_commit ?? "" },
  }));
}
