/**
 * After a release, did /talk conversations pick up their sessions (#8795)?
 * The turns of the running version that had a stored session, counted by
 * outcome: resumed it, or fell back to a fresh start. Counts only; no
 * conversation, person or session is named, so every reader may see it.
 */

import type { Database } from "bun:sqlite";

export interface TalkResumes {
  readonly version: string;
  readonly resumed: number;
  readonly fellBack: number;
}

export function readTalkResumes(db: Database, version: string): TalkResumes {
  const row = db
    .query<{ resumed: number | null; fell_back: number | null }, [string]>(
      `SELECT SUM(resume_outcome = 'resumed') AS resumed, SUM(resume_outcome = 'fallback') AS fell_back
         FROM conversation_run WHERE version = ?1`,
    )
    .get(version);
  return { version, resumed: row?.resumed ?? 0, fellBack: row?.fell_back ?? 0 };
}

/** `3 conversations resumed after release 0.7.9, 1 fell back`; empty when no turn has had a session to resume. */
export function talkResumesWords(t: TalkResumes): string {
  if (t.resumed + t.fellBack === 0) return "";
  return `${t.resumed} ${t.resumed === 1 ? "conversation" : "conversations"} resumed after release ${t.version}, ${t.fellBack} fell back`;
}
