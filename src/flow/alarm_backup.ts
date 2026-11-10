/**
 * The "off-box backup" flow alarm (#10924): the newest copy of the forge to
 * have left the machine is more than 26 hours old, so last night's nightly
 * did not land. Reads what Home reads (`snapshot/off_box.ts`) and the
 * failure the outcome files kept; no network. Pure of the clock: `now` is
 * passed in. A forge that has never sent a copy off the box and has never
 * failed to is not alarmed: it has no off-box backup to be late.
 */

import { lastMirror } from "../snapshot/mirror.ts";
import { lastOffBox } from "../snapshot/off_box.ts";
import { lastSnapshotOutcome } from "../snapshot/outcome.ts";

/** A nightly plus two hours of grace. */
export const BACKUP_ALARM_MS = 26 * 3_600_000;

export interface BackupAlarm {
  readonly fired: boolean;
  /** When the backup became overdue; only when fired. */
  readonly since?: string;
  /** The last failure's cause as one line; only when fired and one is known. */
  readonly cause?: string;
  readonly says: string;
}

/** One line, bounded: the first line of an error, 160 characters at most. */
function oneLine(text: string): string {
  const line = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** The cause of the latest failure, from the snapshot attempt or the mirror pass, whichever failed last. */
export function backupCause(dataDir: string): string | undefined {
  const snap = lastSnapshotOutcome(dataDir);
  const mirror = lastMirror(dataDir);
  const found: { at: number; text: string }[] = [];
  if (snap?.failingSince !== undefined && snap.error) found.push({ at: Date.parse(snap.at), text: `The snapshot failed: ${snap.error}` });
  const mirrorWhy = mirror?.sourceError ?? mirror?.error;
  if (mirror !== undefined && (mirror.failingSince !== undefined || mirror.sourceError !== undefined) && mirrorWhy)
    found.push({ at: Date.parse(mirror.attemptAt), text: `The mirror failed: ${mirrorWhy}` });
  if (found.length === 0) return undefined;
  found.sort((a, b) => (Number.isNaN(b.at) ? 0 : b.at) - (Number.isNaN(a.at) ? 0 : a.at));
  return oneLine(found[0]!.text);
}

export function alarmBackup(dataDir: string, now: Date): BackupAlarm {
  const newest = lastOffBox(dataDir);
  const failing = lastSnapshotOutcome(dataDir)?.failingSince ?? lastMirror(dataDir)?.failingSince;
  if (newest === null && failing === undefined) return { fired: false, says: "No off-box backup has been taken or failed." };
  const age = newest === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(newest);
  if (age <= BACKUP_ALARM_MS) return { fired: false, says: "The newest off-box backup is under 26 hours old." };
  const since = newest === null ? failing! : new Date(Date.parse(newest) + BACKUP_ALARM_MS).toISOString();
  const cause = backupCause(dataDir);
  const held = newest === null ? "No off-box backup has landed" : `The newest off-box backup is ${String(Math.floor(age / 3_600_000))} h old`;
  return { fired: true, since, ...(cause === undefined ? {} : { cause }), says: `${held}.${cause === undefined ? "" : ` ${cause}`}` };
}
