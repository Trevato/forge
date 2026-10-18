/**
 * An open issue the crew found already done on the base branch. The crew
 * says so in one note naming the commits (`crew/already.ts` writes it); the
 * issue stays open for the person who asked to close. This is the read of
 * it, here in core so the asked list can use it without reaching into crew,
 * and the close (`actions/issues.ts`) writes its answer.
 */

import type { Database } from "bun:sqlite";

/** What the crew's already-done note starts with, before the commit ids. */
export const DONE_NOTE = "Done on main already, waiting for you to close it: ";

/** What every already-done note starts with, for `LIKE`. */
export const DONE_LIKE = `${DONE_NOTE.replace(/[%_]/g, "")}%`;

/** What every park note starts with, for `LIKE`. */
export const PARK_LIKE = "Parked by the crew%";

/** What the comment on a close of such an issue starts with. */
export const CLOSED_NOTE = "Closed: already done on main in ";

/** When a comment was written: its time, and its id to order one millisecond. */
export interface Written {
  readonly at: string;
  readonly id: string;
}

/**
 * Comment `a` was written after comment `b`. Two writes can share a
 * millisecond; `id()` is monotonic, so the id orders them as written.
 */
export const LATER = (a: string, b: string): string =>
  `(${a}.created_at, ${a}.id) > (${b}.created_at, ${b}.id)`;

/** `n` is a note written by the crew: the one who set it going, or its own agent. */
export const BY_CREW = `n.origin_author IS NULL AND (n.author_id IN (
    SELECT r.autonomy_by FROM issue i JOIN repo r ON r.id = i.repo_id WHERE i.id = n.issue_id)
  OR n.author_id IN (
    SELECT rc.user_id FROM repo_crew rc JOIN issue i ON i.repo_id = rc.repo_id
     WHERE i.id = n.issue_id))`;

const CHUNK = 400;

/**
 * The commits an open issue was found done by, when the crew's newest word
 * on it is an already-done note and nobody has closed it yet: one read for
 * these issues, empty for the rest. A later park is a newer word.
 */
export function alreadyDone(
  db: Database,
  issueIds: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const batch = issueIds.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 1}`).join(",");
    const rows = db
      .query<{ id: string; body: string }, string[]>(
        `SELECT n.issue_id AS id, n.body FROM comment n JOIN issue o ON o.id = n.issue_id
          WHERE n.issue_id IN (${marks}) AND o.state = 'open'
            AND n.body LIKE '${DONE_LIKE}' AND ${BY_CREW}
            AND NOT EXISTS (SELECT 1 FROM comment q WHERE q.issue_id = n.issue_id
                 AND q.body LIKE '${PARK_LIKE}' AND ${LATER("q", "n")})
          ORDER BY n.created_at, n.id`,
      )
      .all(...batch);
    for (const row of rows) {
      const oids = row.body.match(/\b[0-9a-f]{40}\b/g) ?? [];
      if (oids.length > 0) out.set(row.id, oids.slice(0, 5));
      else out.delete(row.id);
    }
  }
  return out;
}
