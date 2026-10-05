/**
 * A hold on a pull (#773): a person who writes the repository saying "not
 * this one yet", with one line that says why. While a hold stands, no rule
 * sends the pull to the crew's reviewer and no rule lands it; a person's own
 * merge is their own act and still works.
 *
 * A release is kept, not deleted. The review clock starts again from it
 * (`crew/review.ts`), so holding a green pull and letting it go is never a
 * way past the review; and the page can say who let it go.
 *
 * Pure data, no authz, no events (`actions/holds.ts`).
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** One line, with room. */
export const WHY_MAX = 200;

export interface Hold {
  /** The pull's issue id. */
  readonly pullId: string;
  readonly heldBy: string;
  readonly heldByName: string;
  /** Why, in one line. */
  readonly why: string;
  readonly heldAt: string;
}

interface Row {
  issue_id: string;
  held_by: string;
  username: string;
  why: string;
  held_at: string;
}

const fromRow = (row: Row): Hold => ({
  pullId: row.issue_id,
  heldBy: row.held_by,
  heldByName: row.username,
  why: row.why,
  heldAt: row.held_at,
});

const STANDING = `SELECT pull_hold.issue_id, pull_hold.held_by, user.username,
    pull_hold.why, pull_hold.held_at
  FROM pull_hold JOIN user ON user.id = pull_hold.held_by
  WHERE pull_hold.released_at IS NULL`;

/** The reason as it will be kept: plain, one line, or why it will not be. */
export function cleanWhy(
  raw: string,
): Result<string, "empty_why" | "why_too_long"> {
  const why = raw.replace(/\s+/g, " ").trim();
  if (why === "") return err("empty_why");
  if (why.length > WHY_MAX) return err("why_too_long");
  return ok(why);
}

/** The hold that stands on a pull, if one does. */
export function getHold(db: Database, pullId: string): Hold | undefined {
  const row = db
    .query<Row, [string]>(`${STANDING} AND pull_hold.issue_id = ?1`)
    .get(pullId);
  return row ? fromRow(row) : undefined;
}

/** The holds that stand on these pulls, by pull: one read for a list. */
export function holdsFor(
  db: Database,
  pullIds: readonly string[],
): Map<string, Hold> {
  const out = new Map<string, Hold>();
  const CHUNK = 400;
  for (let i = 0; i < pullIds.length; i += CHUNK) {
    const batch = pullIds.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 1}`).join(",");
    for (const row of db
      .query<Row, string[]>(`${STANDING} AND pull_hold.issue_id IN (${marks})`)
      .all(...batch))
      out.set(row.issue_id, fromRow(row));
  }
  return out;
}

/**
 * Hold a pull. A pull holds one hold: holding one that is already held puts
 * the new person and the new words on it, and keeps when it was first held.
 */
export function setHold(
  db: Database,
  pullId: string,
  by: string,
  why: string,
): Hold {
  const changed = db
    .query(
      `UPDATE pull_hold SET held_by = ?2, why = ?3
        WHERE issue_id = ?1 AND released_at IS NULL`,
    )
    .run(pullId, by, why).changes;
  if (changed === 0)
    db.query(
      "INSERT INTO pull_hold (id, issue_id, held_by, why) VALUES (?1, ?2, ?3, ?4)",
    ).run(id(), pullId, by, why);
  return getHold(db, pullId)!;
}

/** Let a pull go. False when nothing held it. */
export function releaseHold(db: Database, pullId: string, by: string): boolean {
  return (
    db
      .query(
        `UPDATE pull_hold SET released_by = ?2,
                released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE issue_id = ?1 AND released_at IS NULL`,
      )
      .run(pullId, by).changes > 0
  );
}

/** When a hold on this pull was last released, if one ever was. */
export function lastRelease(db: Database, pullId: string): string | undefined {
  return (
    db
      .query<{ at: string | null }, [string]>(
        "SELECT MAX(released_at) AS at FROM pull_hold WHERE issue_id = ?1",
      )
      .get(pullId)?.at ?? undefined
  );
}
