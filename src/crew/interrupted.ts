/**
 * An interrupted run is not a park. A builder's run the provider ended —
 * a usage window full, the API unreachable — or the forge stopped by its
 * own restart says nothing about the work: nobody attempted it. Such a run
 * is recorded as `interrupted: <cause>, resumes <when>`, writes no park
 * note and is no strike against the issue; the clock picks it up again.
 */

import type { Database } from "bun:sqlite";
import { whenText } from "./limits.ts";

export type Interruption = "provider limit" | "network error" | "restart";

/** What every interrupted run's summary starts with. */
export const INTERRUPTED = "interrupted: ";

const PROVIDER =
  /rate[ _-]?limit|session limit|usage limit|weekly limit|hit your \w+ limit|overloaded|too many requests|\b(?:429|529)\b|\(api_error\)|may use is resting|resting —/i;
const NETWORK =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|unable to connect|connection error|could not reach|unreachable|socket hang up/i;
const RESTART =
  /^cancelled$|interrupted by a restart|stopped for a restart|the forge stopped/i;

/**
 * Why a run that ended without a pull was cut short, read from its summary
 * — one written by `interruptedSummary`, or an older one that names a
 * provider limit, a network error or a restart — or undefined when the run
 * really ended on the work. A decline is the agent's own word, never this.
 */
export function interruptionOf(summary: string): Interruption | undefined {
  const s = summary.trim();
  if (s.startsWith(INTERRUPTED)) {
    const cause = s.slice(INTERRUPTED.length);
    if (cause.startsWith("provider limit")) return "provider limit";
    if (cause.startsWith("network error")) return "network error";
    return "restart";
  }
  if (/^declined\b/i.test(s)) return undefined;
  if (RESTART.test(s)) return "restart";
  if (PROVIDER.test(s)) return "provider limit";
  if (NETWORK.test(s)) return "network error";
  return undefined;
}

/**
 * The summary a failed run is recorded with: `interrupted: provider limit,
 * resumes 02:00 UTC — <what happened>` when it was cut short, the summary
 * as it was otherwise.
 */
export function interruptedSummary(
  summary: string,
  resumesAt?: Date,
): string {
  if (summary.startsWith(INTERRUPTED)) return summary;
  const cause = interruptionOf(summary);
  if (cause === undefined) return summary;
  const when =
    resumesAt === undefined ? "resumes on the next pass" : `resumes ${whenText(resumesAt)}`;
  return `${INTERRUPTED}${cause}, ${when} — ${summary}`;
}

/** The agent runs on an issue that were interrupted, newest first, for its page. */
export function interruptionsOn(
  db: Database,
  issueId: string,
): { summary: string; at: string }[] {
  return db
    .query<{ summary: string; at: string }, [string]>(
      `SELECT summary, COALESCE(finished_at, created_at) AS at FROM run
       WHERE issue_id = ?1 AND kind = 'agent' AND summary LIKE 'interrupted: %'
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(issueId);
}
