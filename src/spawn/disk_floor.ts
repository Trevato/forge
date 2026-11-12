/**
 * The disk floor: the share of the forge's own volume it keeps for itself
 * (#10850, item 5). Child forges write to the one disk under the parent's
 * data; below the floor no new child forge is made (`spawn/quota.ts`
 * `quotaRefusal`, which the New forge page and menu also show) and no child
 * cell starts (`spawn/cell.ts`; a sleeping one stays asleep), so what room
 * is left is the parent's to recover with. Below it, too (#10873), a child
 * already awake is put to sleep and kept asleep with this module's one line
 * (`spawn/host.ts` `sleepBelowFloor`, `wakeGate`), and no app or check cell
 * starts (`apps/process.ts` `startProcess`, `runStep`). The owner's line is
 * the vitals need `disk-floor` (`kernel/vitals.ts`), which the pager owns
 * (`crew/incidents.ts`): paged once per crossing, Recovered once.
 */

import { readDisk, type DiskReading } from "../kernel/disk_reading.ts";

/** Free disk under this share of the volume and nothing new starts. */
export const DISK_FLOOR = 0.15;

/** The volume under `dir` (`readDisk`, which the suite's preload makes roomy), or undefined when it cannot be read. */
export function diskUnder(dir: string): DiskReading | undefined {
  try {
    return readDisk(dir);
  } catch {
    return undefined;
  }
}

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/**
 * One sentence when the volume under `dir` has less than `DISK_FLOOR` free,
 * else undefined. A volume that cannot be read, or reads as empty, is not
 * refused: the floor protects a disk it can see, it does not guess.
 */
export function floorRefusal(dir: string, disk: DiskReading | undefined = diskUnder(dir)): string | undefined {
  if (disk === undefined || !(disk.totalBytes > 0)) return undefined;
  const share = disk.freeBytes / disk.totalBytes;
  if (share >= DISK_FLOOR) return undefined;
  return `this host's disk has ${(share * 100).toFixed(1)}% free (${gib(disk.freeBytes)} of ${gib(disk.totalBytes)} GiB), under the ${DISK_FLOOR * 100}% it keeps for itself: nothing new starts until room is made`;
}
