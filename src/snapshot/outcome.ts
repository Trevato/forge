/**
 * How the last snapshot went, kept where the board can read it. A nightly
 * that failed used to be one line in the log and nothing else: two nights
 * of no off-box backup went by unseen (2026-10-17, #2536). Each attempt's
 * outcome is one small file under the data directory
 * (`snapshot/state.json`), written when it ends, so vitals and Backups read
 * it without the network and a restart forgets nothing. A failure is a
 * card from the moment it is written until a snapshot lands.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotOutcome {
  /** When the last attempt ended. */
  readonly at: string;
  /** The newest snapshot that landed, and when; absent until one has. */
  readonly landed?: string;
  readonly landedAt?: string;
  /** Whether the store it landed in is off the machine (a bucket, not a directory); absent when not known. */
  readonly offBox?: boolean;
  /**
   * When a snapshot last landed off the machine; kept across landings in a local directory,
   * so moving the destination home does not erase the age of the last real off-box copy (#10924).
   */
  readonly offBoxAt?: string;
  /** Set while attempts are failing: since when, and the last one's reason. */
  readonly failingSince?: string;
  readonly error?: string;
}

const stateFile = (dataDir: string): string => join(dataDir, "snapshot", "state.json");

/** The outcome kept, or undefined when none is or the file is not one. */
export function lastSnapshotOutcome(dataDir: string): SnapshotOutcome | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(dataDir), "utf8")) as SnapshotOutcome;
    if (typeof s.at !== "string") return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** When this outcome's last off-box landing was: the kept time, or the landing itself when it was off the machine. */
export function offBoxAtOf(s: SnapshotOutcome | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (s.offBoxAt !== undefined) return s.offBoxAt;
  return s.offBox === true ? s.landedAt : undefined;
}

/** Keep an attempt's end: a name that landed, or the error it failed with. Returns what was kept. */
export function recordSnapshotOutcome(
  dataDir: string,
  result: { readonly landed: string; readonly offBox?: boolean } | { readonly error: string },
  at: string = new Date().toISOString(),
): SnapshotOutcome {
  const prev = lastSnapshotOutcome(dataDir);
  const kept = {
    ...(prev?.landed === undefined ? {} : { landed: prev.landed }),
    ...(prev?.landedAt === undefined ? {} : { landedAt: prev.landedAt }),
    ...(prev?.offBox === undefined ? {} : { offBox: prev.offBox }),
    ...(offBoxAtOf(prev) === undefined ? {} : { offBoxAt: offBoxAtOf(prev)! }),
  };
  const next: SnapshotOutcome =
    "landed" in result
      ? {
          at,
          landed: result.landed,
          landedAt: at,
          ...(result.offBox === undefined ? {} : { offBox: result.offBox }),
          ...(result.offBox === true ? { offBoxAt: at } : offBoxAtOf(prev) === undefined ? {} : { offBoxAt: offBoxAtOf(prev)! }),
        }
      : { at, ...kept, failingSince: prev?.failingSince ?? at, error: result.error };
  write(dataDir, next);
  return next;
}

/**
 * Say where an outcome kept before the store was recorded landed: the store
 * in effect now, since it is the one it most likely went to. Writes nothing
 * when the outcome already says, or none has landed.
 */
export function noteOffBox(dataDir: string, offBox: boolean): void {
  const prev = lastSnapshotOutcome(dataDir);
  if (prev?.landedAt === undefined || prev.offBox !== undefined) return;
  write(dataDir, { ...prev, offBox });
}

function write(dataDir: string, next: SnapshotOutcome): void {
  mkdirSync(join(dataDir, "snapshot"), { recursive: true });
  const tmp = `${stateFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, stateFile(dataDir));
}

/** The card a failing snapshot is, or undefined while the last one landed. */
export function snapshotNeed(
  s: SnapshotOutcome | undefined,
): { sentence: string; since: string } | undefined {
  if (s?.failingSince === undefined) return undefined;
  const last = s.landedAt ? ` The newest that landed is from ${s.landedAt.slice(0, 10)}.` : "";
  return {
    sentence: `The last snapshot failed: ${(s.error ?? "unknown reason").replace(/\.$/, "")}.${last} The forge tries again within the hour.`,
    since: s.failingSince,
  };
}
