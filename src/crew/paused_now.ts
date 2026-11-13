/**
 * What a pause says on the pull and the app page: the one sentence of
 * `pauseSentence`, for the soonest queued run still waiting out its limit.
 * A pause is a wait the person is told about, never a silence.
 */

import type { Database } from "bun:sqlite";
import { pauseSentence } from "./pacing.ts";

/** The sentence for a queued run paused on `issueId` (a pull or issue) or anywhere in `repoId`; undefined when none waits. */
export function pausedSentence(db: Database, on: { readonly issueId?: string; readonly repoId?: string }, now: Date = new Date()): string | undefined {
  const row = db
    .query<{ summary: string; not_before: string }, [string | null, string | null, string]>(
      `SELECT summary, not_before FROM run
        WHERE kind = 'agent' AND state = 'queued' AND not_before > ?3 AND summary LIKE 'paused%'
          AND (?1 IS NULL OR issue_id = ?1) AND (?2 IS NULL OR repo_id = ?2)
        ORDER BY not_before LIMIT 1`,
    )
    .get(on.issueId ?? null, on.repoId ?? null, now.toISOString());
  if (row === null) return undefined;
  const at = new Date(row.not_before);
  return Number.isNaN(at.getTime()) ? undefined : pauseSentence(row.summary, at, now);
}
