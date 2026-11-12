/**
 * The hard guard on builds (#11799, #11686 item 6): no check or build step's
 * cell starts while the forge's disk is 80% used: `RELEASE_DISK_USED_MAX`
 * (`keeper/cadence.ts`), the one share at which releases pause too. It is the machine's wait, not the pull's: the step says one line
 * why, and a check it stopped is queued again, never failed red
 * (`checks/disk_red.ts`). The child-forge floor (`spawn/disk_floor.ts`, 15%
 * free) is a separate, looser guard and is unchanged.
 */

import { type DiskReading } from "../kernel/disk_reading.ts";
import { diskUnder } from "../spawn/disk_floor.ts";
import { RELEASE_DISK_USED_MAX } from "../keeper/cadence.ts";

/** The words every refusal starts with, so a caller can tell it from a step's own failure. */
export const DISK_USED_REFUSAL = "not started: this host's disk is";

/**
 * One sentence when the volume under `dir` is `RELEASE_DISK_USED_MAX` used or
 * more, else undefined. A disk that cannot be read, or reads as empty, is not
 * refused.
 */
export function usedRefusal(dir: string, disk: DiskReading | undefined = diskUnder(dir)): string | undefined {
  if (disk === undefined || !(disk.totalBytes > 0)) return undefined;
  const used = 1 - disk.freeBytes / disk.totalBytes;
  if (used < RELEASE_DISK_USED_MAX) return undefined;
  return `${DISK_USED_REFUSAL} ${(used * 100).toFixed(1)}% used, at or over the ${RELEASE_DISK_USED_MAX * 100}% builds wait for: queued again when there is room`;
}

/** Whether a step's error is this guard's refusal. */
export const isUsedRefusal = (error: string): boolean => error.includes(DISK_USED_REFUSAL);
