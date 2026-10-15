/**
 * How long each degraded cause held: one span per stretch, opened when the
 * cause first appears in `vitals().degraded`, closed when it is gone. Plain
 * data in, plain data out; the table is `degraded_span`, in the forge's own
 * database. `record` rides the tick that already runs, costs a fixed handful
 * of queries, and never throws into it.
 */

import type { Database } from "bun:sqlite";
import type { Log } from "./log.ts";
import type { Degraded } from "./vitals.ts";

/** Spans closed longer ago than this are deleted on the next record. */
export const KEEP_MS = 30 * 24 * 3_600_000;
/** A cause back within this long of closing extends its span instead of adding one. */
export const FLAP_MS = 60_000;

export interface Span {
  readonly cause: string;
  readonly sentence: string;
  readonly href: string;
  readonly openedAt: number;
  /** Null while the cause still holds. */
  readonly closedAt: number | null;
  /** Milliseconds it held; an open span runs to the `to` asked for. */
  readonly ms: number;
}

interface Row {
  id: number;
  cause: string;
  sentence: string;
  href: string;
  opened_at: number;
  closed_at: number | null;
}

let warned = false;

export function record(
  db: Database,
  degraded: readonly Pick<Degraded, "cause" | "sentence" | "href">[],
  now: number,
  log?: Log,
): void {
  try {
    db.transaction(() => {
      const open = new Map(
        db
          .query<Row, []>("SELECT * FROM degraded_span WHERE closed_at IS NULL")
          .all()
          .map((row) => [row.cause, row]),
      );
      const recent = new Map<string, Row>();
      for (const row of db
        .query<Row, [number]>(
          "SELECT * FROM degraded_span WHERE closed_at >= ?1 ORDER BY closed_at",
        )
        .all(now - FLAP_MS))
        recent.set(row.cause, row);

      const current = new Set<string>();
      for (const d of degraded) {
        if (current.has(d.cause)) continue;
        current.add(d.cause);
        const was = open.get(d.cause);
        if (was) {
          if (was.sentence !== d.sentence || was.href !== d.href)
            db.query(
              "UPDATE degraded_span SET sentence = ?2, href = ?3 WHERE id = ?1",
            ).run(was.id, d.sentence, d.href);
          continue;
        }
        const flapped = recent.get(d.cause);
        if (flapped)
          db.query(
            "UPDATE degraded_span SET closed_at = NULL, sentence = ?2, href = ?3 WHERE id = ?1",
          ).run(flapped.id, d.sentence, d.href);
        else
          db.query(
            "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, ?2, ?3, ?4)",
          ).run(d.cause, d.sentence, d.href, now);
      }
      for (const [cause, row] of open)
        if (!current.has(cause))
          db.query("UPDATE degraded_span SET closed_at = ?2 WHERE id = ?1").run(
            row.id,
            now,
          );
      db.query("DELETE FROM degraded_span WHERE closed_at < ?1").run(
        now - KEEP_MS,
      );
    })();
  } catch (error) {
    if (!warned) {
      warned = true;
      log?.warn("degraded history not recorded", { error: String(error) });
    }
  }
}

/** Every span that overlaps `from`..`to` (epoch ms), oldest first. */
export function spans(db: Database, from: number, to: number): Span[] {
  return db
    .query<Row, [number, number]>(
      `SELECT * FROM degraded_span
        WHERE opened_at < ?2 AND (closed_at IS NULL OR closed_at > ?1)
        ORDER BY opened_at, id`,
    )
    .all(from, to)
    .map((row) => ({
      cause: row.cause,
      sentence: row.sentence,
      href: row.href,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      ms: (row.closed_at ?? to) - row.opened_at,
    }));
}
