/** The release rows: one per checked-out landing, with the preflight verdict. */

import type { Database } from "bun:sqlite";

export interface Release {
  readonly id: number;
  readonly sha: string;
  readonly repoId: string;
  readonly pullNumber: number | null;
  readonly ok: boolean;
  readonly line: string;
  readonly createdAt: string;
}

interface Row {
  id: number;
  sha: string;
  repo_id: string;
  pull_number: number | null;
  ok: number;
  line: string;
  created_at: string;
}

const toRelease = (r: Row): Release => ({
  id: r.id,
  sha: r.sha,
  repoId: r.repo_id,
  pullNumber: r.pull_number,
  ok: r.ok === 1,
  line: r.line,
  createdAt: r.created_at,
});

export function recordRelease(
  db: Database,
  input: { sha: string; repoId: string; pullNumber: number | null; ok: boolean; line: string },
): Release {
  const row = db
    .query<Row, [string, string, number | null, number, string]>(
      `INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`,
    )
    .get(input.sha, input.repoId, input.pullNumber, input.ok ? 1 : 0, input.line)!;
  return toRelease(row);
}

/** Newest first. */
export function listReleases(db: Database, limit = 20): Release[] {
  return db
    .query<Row, [number]>(`SELECT * FROM release ORDER BY id DESC LIMIT ?1`)
    .all(limit)
    .map(toRelease);
}
