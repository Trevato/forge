/**
 * What the explorer's ranking reads, as one short string (#6129).
 *
 * The write clock (`write_clock.ts`) moves on every write in the forge — a
 * session, a heartbeat, a log line — so on a busy forge it says "stale" far
 * more often than the ranking changed. This is the finer question: the
 * columns `actions/explore.ts` ranks, filters and shows by, every grant
 * that decides who may read or enter what (teams and their permission, crew
 * seats, the people a private app names), and the front page's weights,
 * reduced to one hash. Equal hashes mean the ranking would come out the same (up to the
 * passage of time, which its max age covers).
 *
 * Not hashed on purpose: the repo query LEFT JOINs `origin`, which cannot add
 * or drop a row, and no explore row shows anything from it.
 *
 * An input added to the ranking belongs here. `test/explore-speed.test.ts`
 * flips the forks, visibility, access, crew seats, app members and team
 * grants and watches the answer follow; `test/rank-inputs.test.ts` flips
 * pulls, user standing and the weights and watches the hash follow.
 */

import type { Database } from "bun:sqlite";

/** The meter moves every few seconds on a busy forge; its part of the hash is read at most this often. */
export const METER_MAX_AGE_MS = 60_000;

const METER_SQL = `SELECT count(*) || char(31) || COALESCE(max(rowid), 0) || char(31) || count(ended_at) || char(31)
  || COALESCE(max(ended_at), '') || char(31) || COALESCE(max(started_at), '') AS meter FROM meter`;

const metered = new WeakMap<Database, { at: number; sign: string }>();

/** The meter's signature, kept for METER_MAX_AGE_MS so a run starting or ending does not move the hash. */
function meterSign(db: Database): string {
  const now = Date.now();
  const kept = metered.get(db);
  if (kept !== undefined && now - kept.at < METER_MAX_AGE_MS && now >= kept.at) return kept.sign;
  const sign = db.query<{ meter: string }, []>(METER_SQL).get()?.meter ?? "";
  metered.set(db, { at: now, sign });
  return sign;
}

const SQL = `SELECT
  (SELECT group_concat(id || char(31) || owner_id || char(31) || name || char(31) || visibility || char(31)
     || description || char(31) || COALESCE(archived_at, '') || char(31) || COALESCE(fork_parent_id, ''), char(30)) FROM repo) AS repo,
  (SELECT group_concat(id || char(31) || username || char(31) || display_name || char(31) || is_admin || char(31)
     || is_agent || char(31) || kind || char(31) || COALESCE(suspended_at, '') || char(31) || COALESCE(removed_at, ''), char(30)) FROM user) AS user,
  (SELECT group_concat(repo_id || char(31) || access, char(30)) FROM app) AS app,
  (SELECT group_concat(team.id || char(31) || team.org_id || char(31) || team.permission || char(31) || team_member.user_id, char(30))
     FROM team JOIN team_member ON team_member.team_id = team.id) AS team,
  (SELECT group_concat(repo_id || char(31) || user_id, char(30)) FROM repo_crew) AS crew,
  (SELECT group_concat(app_id || char(31) || user_id, char(30)) FROM app_member) AS named,
  (SELECT count(*) || char(31) || COALESCE(max(rowid), 0) FROM feed_like) AS likes,
  (SELECT count(*) || char(31) || COALESCE(max(rowid), 0) || char(31) || count(merged_at) || char(31) || COALESCE(max(merged_at), '')
     FROM pull) AS pull,
  (SELECT group_concat(key || char(31) || value, char(30)) FROM front_setting) AS setting`;

/** A hash of the ranking's inputs; cheap enough to ask on every request the write clock calls stale. */
export function rankInputs(db: Database): string {
  const row = db.query<Record<string, string | null>, []>(SQL).get();
  if (row === null) return "";
  const parts = [...Object.values(row).map((v) => v ?? ""), meterSign(db)];
  return String(Bun.hash(parts.join(String.fromCharCode(29))));
}
