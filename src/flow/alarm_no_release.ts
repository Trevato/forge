/**
 * The "no release" flow alarm (#5930): main has moved and nothing has gone
 * live for 90 minutes. Reads what `/changelog` reads (`release/landings.ts`): the oldest
 * merge the running commit does not yet contain; pure of the clock — `now` is passed in.
 */

import type { Database } from "bun:sqlite";
import { waitingSince } from "../release/landings.ts";
import { running } from "../kernel/version.ts";

export const NO_RELEASE_MS = 90 * 60_000;

export interface NoReleaseAlarm {
  readonly fired: boolean;
  /** When main first moved past the last release; only when fired. */
  readonly since?: string;
  readonly says: string;
}

function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 120) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

export function noReleaseAlarm(db: Database, now: Date): NoReleaseAlarm {
  const moved = waitingSince(db);
  const commit = running().commit;
  const live = commit ? `since ${commit.slice(0, 7)}` : "yet";
  if (moved === undefined || Date.parse(moved) > now.getTime())
    return { fired: false, says: "Nothing has moved on main since the last release." };
  const wait = now.getTime() - Date.parse(moved);
  if (wait < NO_RELEASE_MS) return { fired: false, says: `Main moved ${ago(wait)}; a release is not yet due.` };
  return {
    fired: true,
    since: moved,
    says: `Main moved ${ago(wait)} and nothing has gone live ${live}.`,
  };
}
