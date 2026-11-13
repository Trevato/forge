/**
 * Memory is held, not hit (#11980). A child forge in a cell has one memory
 * limit for itself, its crew run, its checks and its apps. Near that limit a
 * new process is the straw: the host stops the whole forge for it. So while
 * the child's anonymous memory is at or over `HOLD_SHARE` of its limit and
 * something of its own is already running, nothing new starts (the dispatcher
 * keeps an agent run queued, the check queue keeps a check queued) until the
 * running work gives memory back. With nothing running a start is always
 * allowed, so a hold can never be permanent.
 *
 * Only a cell child reads its pressure (`FORGE_CELL_SIZE` is in its
 * environment); on any other forge the answer is always "not held".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryPressure } from "../looks/service.ts";
import { isSize } from "../spawn/sizes.ts";
import { CGROUP_DIR_ENV, SIZE_ENV } from "../spawn/usage.ts";

/** At this share of the limit, in anonymous memory, new work waits. */
export const HOLD_SHARE = 0.75;

export type Pressure = () => number | undefined;

/** A reading is reused this long: the pump and the check tick ask often, the files are on disk. */
export const READING_MS = 1_000;

let last: { readonly base: string; readonly at: number; readonly share: number | undefined } | undefined;

/** How much of its limit this child's cgroup holds in anonymous memory; none off a cell child. */
export function childPressure(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now(),
): number | undefined {
  if (!isSize(env[SIZE_ENV])) return undefined;
  const dir = env[CGROUP_DIR_ENV];
  const base = dir !== undefined && dir.startsWith("/") ? dir : "/sys/fs/cgroup";
  if (last !== undefined && last.base === base && now >= last.at && now - last.at < READING_MS) return last.share;
  const share = readShare(base);
  last = { base, at: now, share };
  return share;
}

function readShare(base: string): number | undefined {
  const read = (name: string): string => readFileSync(join(base, name), "utf8");
  try {
    let stat = "";
    try {
      stat = read("memory.stat");
    } catch {
      // The total will have to do.
    }
    return memoryPressure(stat, read("memory.max"), read("memory.current"));
  } catch {
    return undefined;
  }
}

/**
 * The line saying why nothing new starts, or undefined when something may.
 * `running` is how many of this forge's own runs are going now.
 */
export function memoryHold(running: number, pressure: Pressure = childPressure): string | undefined {
  if (running <= 0) return undefined;
  const share = pressure();
  if (share === undefined || share < HOLD_SHARE) return undefined;
  return `this forge holds ${Math.round(share * 100)}% of its memory; new work waits for a running one to finish`;
}
