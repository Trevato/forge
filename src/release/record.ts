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

/** The newest release of one repository, whatever its verdict; undefined while it has none. */
export function latestReleaseOf(db: Database, repoId: string): Release | undefined {
  const row = db.query<Row, [string]>(`SELECT * FROM release WHERE repo_id = ?1 ORDER BY id DESC LIMIT 1`).get(repoId);
  return row === null ? undefined : toRelease(row);
}

/** Every kept release whose sha starts with these hex digits, newest first, one per sha. */
export function releasesByPrefix(db: Database, hex: string): Release[] {
  if (!/^[0-9a-f]{1,40}$/.test(hex)) return [];
  const seen = new Set<string>();
  return db
    .query<Row, [string]>(`SELECT * FROM release WHERE sha LIKE ?1 || '%' ORDER BY id DESC`)
    .all(hex)
    .map(toRelease)
    .filter((r) => !seen.has(r.sha) && seen.add(r.sha));
}

/** The newest healthy release a pull landed in; undefined while it is in none. */
export function releaseOfPull(db: Database, repoId: string, pullNumber: number): Release | undefined {
  const row = db
    .query<Row, [string, number]>(
      `SELECT * FROM release WHERE repo_id = ?1 AND pull_number = ?2 AND ok = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, pullNumber);
  return row === null ? undefined : toRelease(row);
}

/** What a release is called where people read it: the landed commit, short. */
export const releaseName = (r: Release): string => r.sha.slice(0, 12);

/** What a release is called in plain words: its number and the day it was cut. */
export const releaseLabel = (r: Release): string => {
  const day = new Date(r.createdAt);
  const when = Number.isNaN(day.getTime()) ? r.createdAt.slice(0, 10) : day.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `release ${r.id} (${when})`;
};
