/**
 * The keeper's releases (#7557): one row per version it cut, from the cut
 * to `verified` or `rolled_back`, with the known-good image recorded before
 * the cut and what the probes counted. Plain rows in, plain rows out.
 *
 * Stages: `rolling` (tagged and promoted; the old forge still serves),
 * `verifying` (the new version answers; ten minutes under page load),
 * `verified` (verified live), `rolled_back` (set back to the known-good
 * image, a hold stands).
 */

import type { Database } from "bun:sqlite";
import type { Tally } from "./verify.ts";

export type Stage = "rolling" | "verifying" | "verified" | "rolled_back";
export const IN_FLIGHT: readonly Stage[] = ["rolling", "verifying"];

export interface KeeperRelease {
  readonly id: number;
  readonly version: string;
  readonly sha: string;
  readonly knownGood: { readonly version: string; readonly image: string };
  readonly stage: Stage;
  readonly cutAt: string;
  readonly liveAt: string | null;
  readonly finishedAt: string | null;
  readonly rollProbes: number;
  readonly rollNon200: number;
  readonly probes: number;
  readonly pages: number;
  readonly badInRow: number;
  readonly worstMs: number;
  readonly secondsDark: number;
  /** The worst event-loop stall in the release's first five minutes, ms (#8848). */
  readonly worstStallMs: number;
  readonly reason: string;
}

interface Row {
  id: number;
  version: string;
  sha: string;
  known_good_version: string;
  known_good_image: string;
  stage: Stage;
  cut_at: string;
  live_at: string | null;
  finished_at: string | null;
  roll_probes: number;
  roll_non200: number;
  probes: number;
  pages: number;
  bad_in_row: number;
  worst_ms: number;
  seconds_dark: number;
  worst_stall_ms: number;
  reason: string;
}

const toRelease = (r: Row): KeeperRelease => ({
  id: r.id,
  version: r.version,
  sha: r.sha,
  knownGood: { version: r.known_good_version, image: r.known_good_image },
  stage: r.stage,
  cutAt: r.cut_at,
  liveAt: r.live_at,
  finishedAt: r.finished_at,
  rollProbes: r.roll_probes,
  rollNon200: r.roll_non200,
  probes: r.probes,
  pages: r.pages,
  badInRow: r.bad_in_row,
  worstMs: r.worst_ms,
  secondsDark: r.seconds_dark,
  worstStallMs: r.worst_stall_ms,
  reason: r.reason,
});

const iso = (ms: number) => new Date(ms).toISOString();

/** The cut, written before the tag is pushed: the known-good image is on record before anything can need it. */
export function recordCut(
  db: Database,
  input: { version: string; sha: string; knownGood: { version: string; image: string }; at: number },
): KeeperRelease {
  return toRelease(
    db
      .query<Row, [string, string, string, string, string]>(
        `INSERT INTO keeper_release (version, sha, known_good_version, known_good_image, stage, cut_at)
         VALUES (?1, ?2, ?3, ?4, 'rolling', ?5) RETURNING *`,
      )
      .get(input.version, input.sha, input.knownGood.version, input.knownGood.image, iso(input.at))!,
  );
}

/** A cut whose tag was refused never happened: its row goes, so the cadence is not left waiting on it. */
export function dropCut(db: Database, id: number): void {
  db.query(`DELETE FROM keeper_release WHERE id = ?1 AND stage = 'rolling' AND live_at IS NULL`).run(id);
}

/** One more `/healthz` probe while the roll runs. */
export function countRollProbe(db: Database, id: number, ok: boolean): void {
  db.query(
    `UPDATE keeper_release SET roll_probes = roll_probes + 1, roll_non200 = roll_non200 + ?2,
       seconds_dark = seconds_dark + ?2 WHERE id = ?1 AND stage = 'rolling'`,
  ).run(id, ok ? 0 : 1);
}

/** The new version answers: the verify begins. Only one forge moves it, so a second caller gets false. */
export function markLive(db: Database, id: number, at: number): boolean {
  return db.query(`UPDATE keeper_release SET stage = 'verifying', live_at = ?2 WHERE id = ?1 AND stage = 'rolling'`).run(id, iso(at))
    .changes === 1;
}

/** The verify's numbers so far: the seconds dark it saw are added to the roll's. */
export function keepTally(db: Database, id: number, t: Tally, rollDark: number): void {
  db.query(
    `UPDATE keeper_release SET probes = ?2, pages = ?3, bad_in_row = ?4, worst_ms = ?5, seconds_dark = ?6 WHERE id = ?1`,
  ).run(id, t.probes, t.pages, t.worstRun, t.worstMs, rollDark + t.secondsDark);
}

/** The worst stall the release's process saw in its first five minutes. */
export function keepStall(db: Database, id: number, ms: number): void {
  db.query(`UPDATE keeper_release SET worst_stall_ms = ?2 WHERE id = ?1`).run(id, Math.max(0, Math.round(ms)));
}

/** The release before this one, cut and finished, newest first: what a stall is compared with. */
export function releaseBefore(db: Database, id: number): KeeperRelease | undefined {
  const row = db
    .query<Row, [number]>(`SELECT * FROM keeper_release WHERE id < ?1 AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(id);
  return row === null ? undefined : toRelease(row);
}

export function finish(db: Database, id: number, stage: "verified" | "rolled_back", reason: string, at: number): void {
  db.query(`UPDATE keeper_release SET stage = ?2, reason = ?3, finished_at = ?4 WHERE id = ?1`).run(id, stage, reason, iso(at));
}

/** Newest first. */
export function listKeeperReleases(db: Database, limit = 20): KeeperRelease[] {
  return db.query<Row, [number]>(`SELECT * FROM keeper_release ORDER BY id DESC LIMIT ?1`).all(limit).map(toRelease);
}

/** The release the keeper has not finished with, if any. */
export function inFlight(db: Database): KeeperRelease | undefined {
  const row = db
    .query<Row, []>(`SELECT * FROM keeper_release WHERE stage IN ('rolling', 'verifying') ORDER BY id DESC LIMIT 1`)
    .get();
  return row === null ? undefined : toRelease(row);
}

export function getKeeperRelease(db: Database, id: number): KeeperRelease | undefined {
  const row = db.query<Row, [number]>(`SELECT * FROM keeper_release WHERE id = ?1`).get(id);
  return row === null ? undefined : toRelease(row);
}
