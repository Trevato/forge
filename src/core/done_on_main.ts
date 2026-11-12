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
export const PARK_LEAD = "Parked by the crew";
export const PARK_LIKE = `${PARK_LEAD}%`;

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

/**
 * A person reopened this issue: its newest state event is a reopen by
 * someone who is not an agent. That stands until a person closes it, or a
 * pull lands for it; nothing the crew notes about the base closes it.
 */
export function reopenedByPerson(db: Database, repoId: string, number: number): boolean {
  const row = db
    .query<{ kind: string; agent: number | null; person: string | null }, [string, number]>(
      `SELECT e.kind AS kind, u.is_agent AS agent, u.id AS person FROM event e LEFT JOIN user u ON u.id = e.actor_id
        WHERE e.repo_id = ?1 AND e.kind IN ('issue.closed', 'issue.reopened')
          AND json_extract(e.payload, '$.number') = ?2
        ORDER BY e.id DESC LIMIT 1`,
    )
    .get(repoId, number);
  return row !== null && row.kind === "issue.reopened" && row.person !== null && row.agent !== 1;
}

/** The unticked `- [ ]` items of an issue body, as written; fenced code is not a list. */
export function unticked(body: string): string[] {
  const open = body.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, "");
  return [...open.matchAll(/^[ \t]*[-*+][ \t]+\[ \][ \t]+(.+)$/gm)].map((m) => m[1]!.trim());
}

/**
 * `body` with the given boxes ticked: each number counts the unticked boxes
 * as `unticked` lists them, from 1. The boxes that were ticked, as written;
 * a number that names no box is ignored.
 */
export function tickBoxes(body: string, boxes: readonly number[]): { body: string; ticked: string[] } {
  // Fenced code is blanked, not cut, so the offsets still say where the boxes are in `body`.
  const open = body.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, (m) => m.replace(/[^\n]/g, " "));
  const found = [...open.matchAll(/^([ \t]*[-*+][ \t]+)\[ \]([ \t]+(.+))$/gm)];
  const ticked: string[] = [];
  let out = body;
  for (const n of [...new Set(boxes)].sort((a, b) => b - a)) {
    const m = found[n - 1];
    if (m === undefined) continue;
    const at = m.index! + m[1]!.length;
    out = `${out.slice(0, at)}[x]${out.slice(at + 3)}`;
    ticked.unshift(m[3]!.trim());
  }
  return { body: out, ticked };
}

/** The one line a pull carries when an issue it names keeps work left. */
export function leftNote(number: number, left: readonly string[]): string {
  return `Left #${number} open: ${left.length} unticked item${left.length === 1 ? "" : "s"} remain (${left
    .slice(0, 3)
    .join("; ")}${left.length > 3 ? "; …" : ""}).`;
}

/** What the note on an issue left open by a landing starts with (#8482). */
export const LANDED_LEAD = "Left open after pull #";

/**
 * The note the issue itself carries when a pull that closes it lands with
 * boxes unticked: which pull, what is left, and that the crew waits for a
 * person rather than sending a builder to redo shipped work.
 */
export function landedNote(pull: number, left: readonly string[]): string {
  return `${LANDED_LEAD}${pull} landed: ${left.length} unticked ${left.length === 1 ? "item remains" : "items remain"} (${left
    .slice(0, 3)
    .join("; ")}${left.length > 3 ? "; …" : ""}). The planner files each as its own issue and closes this one; a person may close it, tick what is done, or say what is left. Until then the crew does not pick it again.`;
}

/** What the reviewer's note on an issue starts with, when it ticked boxes at its pull's head (#8682). */
export const PASS_LEAD = "Reviewed pull #";
