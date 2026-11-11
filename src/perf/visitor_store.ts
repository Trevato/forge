/**
 * What is kept of a returning visitor (#11265): per visitor id, first and last
 * seen, days seen, visit count, the entry referrer of the first and latest
 * visit, the furthest step reached, and the ordered paths of each visit (path
 * only, no query string). Never an address or a user agent: the probable id is
 * a salted hash and the salt (30 days) is the only thing that could undo it.
 *
 * A visit is a run of views with no gap over 30 minutes. A row untouched for
 * 13 months is deleted (`purgeVisitors`, run by the maintenance duty).
 */

import type { Database } from "bun:sqlite";
import { dayOf } from "../web/measure.ts";
import { SALT_MS, STEPS, type VisitorKind } from "./visitor_id.ts";

export const VISIT_GAP_MS = 30 * 60_000;
export const PAGES_MAX = 40;
export const KEEP_MS = 396 * 86_400_000;
const REF_MAX = 100;
/** New visitor rows a forge takes in one day; a beacon past it keeps nothing and sets no cookie. */
export const NEW_PER_DAY = 5000;

/** The 30-day salt: made on first use, the one before kept so a reading near the turn is not blind, older ones deleted. */
export function visitorSalt(db: Database, at: number): string {
  const period = Math.floor(at / SALT_MS);
  const found = db.query<{ salt: string }, [number]>("SELECT salt FROM visitor_salt WHERE period = ?1").get(period);
  if (found !== null) return found.salt;
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO visitor_salt (period, salt) VALUES (?1, ?2)").run(period, salt);
    db.query("DELETE FROM visitor_salt WHERE period < ?1").run(period - 1);
  })();
  return db.query<{ salt: string }, [number]>("SELECT salt FROM visitor_salt WHERE period = ?1").get(period)!.salt;
}

export interface Seen {
  readonly id: string;
  readonly kind: VisitorKind;
  readonly path: string;
  readonly ref: string;
  readonly step: number;
  readonly at: number;
}

/** Record one page view of a visitor. False when the visitor is new and today's cap on new visitors is spent: nothing is kept. */
export function noteVisitor(db: Database, v: Seen, cap: number = NEW_PER_DAY): boolean {
  const ref = v.ref.slice(0, REF_MAX);
  const path = (v.path.split(/[?#]/)[0] ?? "/").slice(0, 200);
  return db.transaction(() => {
    const known = db.query<{ last_seen: number }, [string]>("SELECT last_seen FROM visitor WHERE id = ?1").get(v.id);
    if (known === null) {
      const today = db
          .query<{ n: number }, [string, number]>(
            "SELECT COUNT(DISTINCT v.visitor) AS n FROM visitor_visit v JOIN visitor w ON w.id = v.visitor WHERE v.day = ?1 AND w.first_seen >= ?2",
          )
          .get(dayOf(v.at), Math.floor(v.at / 86_400_000) * 86_400_000)?.n ?? 0;
      if (today >= cap) return false;
    }
    const last = db
      .query<{ id: number; last: number; pages: string }, [string]>("SELECT id, last, pages FROM visitor_visit WHERE visitor = ?1 ORDER BY id DESC LIMIT 1")
      .get(v.id);
    const continues = last !== null && v.at - last.last <= VISIT_GAP_MS;
    if (known === null) {
      db.query(
        `INSERT INTO visitor (id, kind, first_seen, last_seen, days_seen, visits, first_ref, last_ref, step)
         VALUES (?1, ?2, ?3, ?3, 1, 1, ?4, ?4, ?5)`,
      ).run(v.id, v.kind, v.at, ref, v.step);
    } else {
      db.query(
        `UPDATE visitor SET last_seen = ?2, step = MAX(step, ?3),
           days_seen = days_seen + ?4, visits = visits + ?5, last_ref = CASE WHEN ?5 = 1 THEN ?6 ELSE last_ref END
         WHERE id = ?1`,
      ).run(v.id, Math.max(known.last_seen, v.at), v.step, dayOf(known.last_seen) === dayOf(v.at) ? 0 : 1, continues ? 0 : 1, ref);
    }
    if (continues && last !== null) {
      const pages = JSON.parse(last.pages) as string[];
      if (pages.length < PAGES_MAX) pages.push(path);
      db.query("UPDATE visitor_visit SET last = ?2, pages = ?3 WHERE id = ?1").run(last.id, v.at, JSON.stringify(pages));
    } else {
      db.query("INSERT INTO visitor_visit (visitor, day, started, last, entry_ref, pages) VALUES (?1, ?2, ?3, ?3, ?4, ?5)").run(
        v.id,
        dayOf(v.at),
        v.at,
        ref,
        JSON.stringify([path]),
      );
    }
    return true;
  })();
}

/** Starting or buying a forge makes the visitor someone: its id is linked to the forge's name, on the host's side only. */
export function linkVisitor(db: Database, id: string, forge: string, step: "started" | "paid", at: number): boolean {
  const n = STEPS.indexOf(step === "paid" ? "paid" : "started a forge");
  const done = db
    .query("UPDATE visitor SET forge = ?2, linked_at = ?3, step = MAX(step, ?4) WHERE id = ?1 AND (forge = '' OR forge = ?2)")
    .run(id, forge.slice(0, 100), at, n);
  return done.changes === 1;
}

/** Rows not seen for 13 months, and their visits. Returns the visitors removed. */
export function purgeVisitors(db: Database, now: number): number {
  const cut = now - KEEP_MS;
  return db.transaction(() => {
    db.query("DELETE FROM visitor_visit WHERE visitor IN (SELECT id FROM visitor WHERE last_seen < ?1)").run(cut);
    db.query("DELETE FROM visitor_visit WHERE last < ?1").run(cut);
    return db.query("DELETE FROM visitor WHERE last_seen < ?1").run(cut).changes;
  })();
}
