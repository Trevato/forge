/**
 * The "release tick quiet" flow alarm (#11890): the release tick has not
 * reported a heartbeat (`keeper/beat.ts`) for {@link SILENT_MS} (60 min), so
 * production can fall behind main with nothing deciding to release. One alarm,
 * saying when the tick was last heard and its outcome, never its reason: the
 * alarm reaches home, /boards, the notifier and the MCP `flow` tool, and the
 * reason is shown only to readers of /releases (as with `main_ahead`). On a forge whose keeper
 * has cut a release before, never having had a beat fires it too, counted from
 * the newest cut. A fresh beat clears it. Pure of the clock: `now` is passed in.
 */

import type { Database } from "bun:sqlite";
import { agoWords, lastBeat, SILENT_MS } from "../keeper/beat.ts";

export interface ReleaseQuietAlarm {
  readonly fired: boolean;
  /** When the tick was last heard (or, never heard, the newest cut); only when fired. */
  readonly since?: string;
  readonly says: string;
}

export function releaseQuietAlarm(db: Database, now: Date): ReleaseQuietAlarm {
  const beat = lastBeat(db);
  if (beat !== null) {
    const age = now.getTime() - Date.parse(beat.at);
    if (!(age > SILENT_MS)) return { fired: false, says: `The release tick reported ${agoWords(age)}.` };
    return {
      fired: true,
      since: beat.at,
      says: `The release tick was last heard from ${agoWords(age)} (${beat.outcome}); its reason is on /releases.`,
    };
  }
  // Never a beat: only a forge that has released before expects one. One bounded row.
  const cut = db.query<{ cut_at: string }, []>("SELECT cut_at FROM keeper_release ORDER BY id DESC LIMIT 1").get();
  if (cut === null) return { fired: false, says: "The release tick has never reported, and this forge has not released." };
  const age = now.getTime() - Date.parse(cut.cut_at);
  if (!(age > SILENT_MS)) return { fired: false, says: "The release tick has never reported; the last release was cut within the hour." };
  return {
    fired: true,
    since: cut.cut_at,
    says: `The release tick has never been heard from: no heartbeat since the last release was cut ${agoWords(age)}.`,
  };
}
