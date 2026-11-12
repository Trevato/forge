/**
 * The "no release" flow alarm (#5930): main has moved and nothing has gone
 * live for 90 minutes. Reads what `/changelog` reads (`release/landings.ts`): the oldest
 * merge the running commit does not yet contain; pure of the clock — `now` is passed in.
 * Its words name what production runs, how many merged pulls wait and for how long (#11673).
 */

import type { Database } from "bun:sqlite";
import { waiting } from "../release/landings.ts";
import { running, runningLine } from "../kernel/version.ts";

export const NO_RELEASE_MS = 90 * 60_000;

export interface NoReleaseAlarm {
  readonly fired: boolean;
  /** When main first moved past the last release; only when fired. */
  readonly since?: string;
  readonly says: string;
}

/** A wait in words: `91 min`, `5 h 50 min`. */
export function span(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 120) return `${min} min`;
  const rest = min % 60;
  return rest === 0 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 60)} h ${rest} min`;
}

export function noReleaseAlarm(db: Database, now: Date): NoReleaseAlarm {
  const moved = waiting(db);
  if (moved === undefined || Date.parse(moved.since) > now.getTime())
    return { fired: false, says: "Nothing has moved on main since the last release." };
  const wait = now.getTime() - Date.parse(moved.since);
  if (wait < NO_RELEASE_MS) return { fired: false, says: `Main moved ${span(wait)} ago; a release is not yet due.` };
  const pulls = moved.count === 1 ? "1 merged pull has" : `${moved.count} merged pulls have`;
  return {
    fired: true,
    since: moved.since,
    says: `${pulls} waited ${span(wait)} and nothing has gone live: production runs ${runningLine(running())}.`,
  };
}
