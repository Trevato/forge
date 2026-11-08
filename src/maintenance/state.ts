/**
 * The one file of maintenance state, `maintenance.json` under the data
 * directory: it survives the power-off because the data does. Plain data in,
 * plain data out; a missing or unreadable file reads as "not in maintenance",
 * so a damaged file can never keep the crew paused.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Backup {
  readonly ok: boolean;
  readonly says: string;
}

export interface Maintenance {
  readonly since: string;
  readonly by: string;
  /** One line the maintenance page shows, 0 to 200 characters. */
  readonly reason: string;
  /** The release hold this request placed (`keeper/hold.ts`); lifted when the forge returns. */
  readonly holdId: number;
  readonly backup: Backup;
  /** The host's boot id when prepared: a different one at boot means the host was powered off. */
  readonly bootId?: string;
}

export interface Returned {
  readonly at: string;
  readonly downSince: string;
  readonly says: string;
  /** One line per check: `ok name: says` or `FAILED name: says`. */
  readonly verified: readonly string[];
  /** The same checks as data, for a page or screen that sets name and result apart. */
  readonly checks?: readonly { readonly name: string; readonly ok: boolean; readonly says: string }[];
  /** False when any check failed; absent in a record from before the checks. */
  readonly healthy?: boolean;
  /** What is healthy and what is not, in one line. */
  readonly summary?: string;
}

export interface Stored {
  readonly current?: Maintenance;
  /** The last return, kept so an admin is told when it is back and what is healthy. */
  readonly last?: Returned;
}

const file = (dataDir: string): string => join(dataDir, "maintenance.json");

export function readState(dataDir: string): Stored {
  try {
    if (!existsSync(file(dataDir))) return {};
    const raw: unknown = JSON.parse(readFileSync(file(dataDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const o = raw as Stored;
    const cur = o.current;
    const good =
      cur !== undefined &&
      typeof cur.since === "string" &&
      typeof cur.holdId === "number" &&
      typeof cur.backup?.ok === "boolean";
    return { ...(good ? { current: cur } : {}), ...(o.last !== undefined && typeof o.last.at === "string" ? { last: o.last } : {}) };
  } catch {
    return {};
  }
}

export function writeState(dataDir: string, state: Stored): void {
  const tmp = `${file(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file(dataDir));
}

/** Is the forge in maintenance? The dispatcher asks on every pass. */
export function inMaintenance(dataDir: string): boolean {
  return readState(dataDir).current !== undefined;
}
