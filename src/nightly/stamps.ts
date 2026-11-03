/**
 * What each nightly job last did, one small file apiece under
 * `FORGE_APP_DATA/nightly`: the slot it kept, when it began and ended, and
 * what it said. The record is written as a run begins, so a restart in the
 * middle of a long hunt does not start it again; a hunt cut short is next
 * night's, and says so. Nothing here cannot be rebuilt.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Last {
  /** The slot this run kept, not the time it got to start: a job queued behind another still keeps its own. */
  readonly slot: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** One plain sentence: what it filed, what failed, why it did not run. */
  readonly says: string;
}

const fileOf = (dataDir: string, name: string): string => join(dataDir, "nightly", `${name}.json`);

/** The record of `name`, or undefined when it never ran or the file is not one. */
export function readLast(dataDir: string, name: string): Last | undefined {
  try {
    const v = JSON.parse(readFileSync(fileOf(dataDir, name), "utf8")) as Partial<Record<keyof Last, unknown>>;
    const whole = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    if (!whole(v.slot) || !whole(v.startedAt) || typeof v.says !== "string") return undefined;
    return { slot: v.slot, startedAt: v.startedAt, says: v.says, ...(whole(v.finishedAt) ? { finishedAt: v.finishedAt } : {}) };
  } catch {
    return undefined;
  }
}

export function writeLast(dataDir: string, name: string, last: Last): void {
  mkdirSync(join(dataDir, "nightly"), { recursive: true });
  writeFileSync(fileOf(dataDir, name), JSON.stringify(last));
}
