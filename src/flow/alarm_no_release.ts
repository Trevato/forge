/**
 * The "no release" flow alarm (#5930): main has moved and nothing has gone
 * live for 90 minutes. Reads the release record `/releases` reads and the
 * merges into the default branch; pure of the clock — `now` is passed in.
 */

import type { Database } from "bun:sqlite";
import { listReleases } from "../release/record.ts";

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
  const last = listReleases(db, 50).find((r) => r.ok);
  const after = last?.createdAt ?? "";
  const moved = db
    .query<{ at: string }, [string, string]>(
      `SELECT MIN(p.merged_at) AS at FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch AND p.merged_at IS NOT NULL AND p.merged_at > ?1 AND p.merged_at <= ?2`,
    )
    .get(after, now.toISOString())?.at;
  const live = last ? `since ${last.sha.slice(0, 7)}` : "yet";
  if (!moved) return { fired: false, says: "Nothing has moved on main since the last release." };
  const wait = now.getTime() - Date.parse(moved);
  if (wait < NO_RELEASE_MS) return { fired: false, says: `Main moved ${ago(wait)}; a release is not yet due.` };
  return {
    fired: true,
    since: moved,
    says: `Main moved ${ago(wait)} and nothing has gone live ${live}.`,
  };
}
