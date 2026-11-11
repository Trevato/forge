/** What the flow keeper writes: events of its own kind, a probe for each finding, a line on a pull said once. */

import type { Database } from "bun:sqlite";
import { addComment } from "../../core/issues.ts";
import { EventBus } from "../../core/events.ts";
import type { Probe } from "../duty.ts";

export const probe = (what: string, number: number, now: Date): Probe => ({ kind: "measurement", what, number, at: now.toISOString() });

/** The keeper's event: durable, on the repository when there is one. */
export function note(db: Database, kind: string, repoId: string | undefined, payload: Record<string, unknown>): void {
  new EventBus(db).append({ kind, repoId, payload });
}

/** How many events of `kind` carry `field` = `value` (and, when given, `head`). */
export function countNotes(db: Database, kind: string, field: string, value: string, head?: string): number {
  return db
    .query<{ n: number }, [string, string, string, string | null]>(
      `SELECT count(*) AS n FROM event WHERE kind = ?1 AND json_extract(payload, '$.' || ?2) = ?3
          AND (?4 IS NULL OR json_extract(payload, '$.head') = ?4)`,
    )
    .get(kind, field, value, head ?? null)!.n;
}

/** Who the forge speaks for on a pull: the person who turned autonomy on, else the owner (the pattern `crew/finishing.ts` uses for a hand-over). */
export function speaker(db: Database, repoId: string): string {
  return db
    .query<{ who: string }, [string]>("SELECT COALESCE(autonomy_by, owner_id) AS who FROM repo WHERE id = ?1")
    .get(repoId)!.who;
}

export const SAID_UNDER = " (The forge posts this under your name; you did not write it.)";

/** One comment on a pull, tagged by `key`, written once however often it is asked. True when this call wrote it. */
export function sayOnce(db: Database, pull: { id: string; repoId: string }, key: string, body: string): boolean {
  if (countNotes(db, "keeper_said", "key", key) > 0) return false;
  const said = addComment(db, { issueId: pull.id, authorId: speaker(db, pull.repoId), body: `Flow keeper: ${body}${SAID_UNDER}` });
  if (!said.ok) return false;
  note(db, "keeper_said", pull.repoId, { key, pull: pull.id });
  return true;
}
