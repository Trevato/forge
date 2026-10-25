/**
 * A red recorded while the check machine's disk was under its free floor is
 * the machine's, not the pull's (#5453): a full disk sank unrelated pulls
 * whose builders found nothing to fix, and one such red is enough, unlike
 * `shared_red.ts`, which needs three pulls to agree. So the check service
 * records the disk's free fraction on every red run (`CheckDetail.diskFree`),
 * the crew neither reworks nor parks one that finished under
 * `DISK_FREE_MIN` and checks it again once the disk is back above the floor,
 * and the vitals carry one card for all of them.
 *
 * Plain data: a reading in, a verdict out; the one place the disk is read is
 * {@link diskReading}, which a test replaces.
 */

import type { Database } from "bun:sqlite";
import type { CheckDetail, Run } from "../core/runs.ts";
import { idFloor } from "../kernel/id.ts";
import { DISK_FREE_MIN, statDisk, type DiskReading } from "../kernel/vitals.ts";

/** How far back a disk-full red still counts for the card. */
export const DISK_RED_WINDOW_MS = 3_600_000;

/** Checks are created before they finish; see `shared_red.ts`. */
const QUEUED_SLACK_MS = 6 * 3_600_000;

/** Where the disk is read from; a test swaps `read` for plain data. */
export const diskReading: { read: (dir: string) => DiskReading } = { read: statDisk };

/** The free share of a reading, 0..1; undefined for a volume that reports no size. */
export const freeFraction = (d: DiskReading): number | undefined =>
  d.totalBytes > 0 ? d.freeBytes / d.totalBytes : undefined;

/** Whether a free share is under the floor. */
export const underFloor = (free: number | undefined): boolean =>
  free !== undefined && free < DISK_FREE_MIN;

/** A failed check's detail with the disk's free share recorded on it. */
export function withDisk(detail: CheckDetail | undefined, dataDir: string): CheckDetail {
  const free = freeFraction(diskReading.read(dataDir));
  const base = detail ?? { passed: 0, failed: 0, names: [] };
  return free === undefined ? base : { ...base, diskFree: free };
}

/** Whether a run finished red while the disk was under its floor. */
export const diskRed = (run: Pick<Run, "checkDetail"> | undefined): boolean =>
  underFloor(run?.checkDetail?.diskFree);

/** Whether the disk under `dataDir` is back above the floor. */
export const diskRecovered = (dataDir: string): boolean => {
  const free = freeFraction(diskReading.read(dataDir));
  return free === undefined || free >= DISK_FREE_MIN;
};

export interface DiskRed {
  /** Pull checks that failed with the disk under the floor in the window. */
  readonly checks: number;
  /** The lowest free share any recorded. */
  readonly free: number;
  /** When the earliest finished. */
  readonly since: string;
}

/** The disk-full reds of the last hour, or undefined when there are none. */
export function diskReds(db: Database, now: number = Date.now()): DiskRed | undefined {
  const row = db
    .query<{ n: number; free: number | null; since: string | null }, [string, string, number]>(
      `SELECT COUNT(*) AS n,
              MIN(json_extract(check_detail, '$.diskFree')) AS free,
              MIN(finished_at) AS since
         FROM run
        WHERE id >= ?1 AND finished_at >= ?2
          AND kind = 'check' AND issue_id IS NOT NULL AND state = 'failed'
          AND json_valid(check_detail)
          AND json_type(check_detail, '$.diskFree') IN ('real', 'integer')
          AND json_extract(check_detail, '$.diskFree') < ?3`,
    )
    .get(
      idFloor(now - DISK_RED_WINDOW_MS - QUEUED_SLACK_MS),
      new Date(now - DISK_RED_WINDOW_MS).toISOString(),
      DISK_FREE_MIN,
    );
  if (row === null || row.n === 0 || row.free === null || row.since === null) return undefined;
  return { checks: row.n, free: row.free, since: row.since };
}

/** The card's sentence: how many checks, and how full the disk was. */
export const diskRedSentence = (r: DiskRed): string =>
  `The check machine's disk was full when ${r.checks} check${r.checks === 1 ? "" : "s"} failed: ${Math.round(r.free * 100)}% free, under the ${Math.round(DISK_FREE_MIN * 100)}% floor — the machine's red, not the pulls'; they wait for the disk, unparked.`;
