/**
 * Page views, kept for the traffic view (`views_report.ts`). A request only
 * pushes a plain row onto an in-memory buffer (`noteView`, no SQL); a timer
 * writes the whole buffer in one transaction (`flushViews`), off the request
 * path. The buffer is bounded, so a flood drops views rather than memory, and
 * a day keeps at most `DAY_MAX` rows per scope. Rows are kept 90 days.
 *
 * The visitor is the existing daily-salted hash (`web/measure.ts` `saltFor`),
 * with the scope; the salt is read once a day, not per view.
 */

import type { Database } from "bun:sqlite";
import { quietly } from "../core/write_clock.ts";
import { sha256 } from "../kernel/hash.ts";
import { withoutWaiting } from "../kernel/db.ts";
import { dayOf, saltFor } from "../web/measure.ts";
import { forgetVisits } from "./views_report.ts";
import { isScraperAgent, type Origin } from "./sources.ts";
import { during } from "./jobs.ts";

export const BUFFER_MAX = 5_000;
export const DAY_MAX = 50_000;
/** Views one visitor may leave in a scope in a day: one client cannot crowd the day out with invented paths. */
export const VISITOR_DAY_MAX = 300;
export const KEEP_DAYS = 90;
const FLUSH_MS = 10_000;

interface Row {
  readonly scope: string;
  readonly day: string;
  readonly at: number;
  readonly visitor: string;
  readonly path: string;
  readonly origin: Origin;
  readonly scraper: boolean;
}

const buffers = new WeakMap<Database, Row[]>();
const salts = new WeakMap<Database, { day: string; salt: string }>();

function saltOf(db: Database, at: number): string {
  const day = dayOf(at);
  const held = salts.get(db);
  if (held?.day === day) return held.salt;
  const salt = saltFor(db, at);
  salts.set(db, { day, salt });
  return salt;
}

/** Push one view; false when the buffer is full and it was dropped. No SQL after the day's first. */
export function noteView(
  db: Database,
  view: { scope: string; path: string; origin: Origin; client: string; agent: string; at?: number },
): boolean {
  const at = view.at ?? Date.now();
  let buffer = buffers.get(db);
  if (buffer === undefined) {
    buffer = [];
    buffers.set(db, buffer);
  }
  if (buffer.length >= BUFFER_MAX) return false;
  buffer.push({
    scope: view.scope,
    day: dayOf(at),
    at,
    visitor: sha256(`${saltOf(db, at)}\0views\0${view.scope}\0${view.client}\0${view.agent}`).slice(0, 32),
    path: view.path.slice(0, 200),
    origin: view.origin,
    scraper: isScraperAgent(view.agent),
  });
  return true;
}

/** Views waiting to be written. */
export const pendingViews = (db: Database): number => buffers.get(db)?.length ?? 0;

/** Write what is buffered, in one transaction; on failure the rows stay for the next try. */
export function flushViews(db: Database, now: number = Date.now()): number {
  const buffer = buffers.get(db);
  if (buffer === undefined || buffer.length === 0) return 0;
  const taken = buffer.slice();
  withoutWaiting(
    db,
    db.transaction(() =>
      quietly(db, () => {
        const insert = db.query(
          `INSERT INTO traffic_view (scope, day, at, visitor, path, ref_host, source, medium, campaign, out_host, scraper)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        );
        const held = new Map<string, number>();
        const heldVisitor = new Map<string, number>();
        const ofVisitor = db.query<{ n: number }, [string, string, number]>(
          "SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1 AND visitor = ?2 AND at >= ?3 AND at < ?3 + 86400000",
        );
        const count = db.query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND at < ?2 + 86400000",
        );
        for (const r of taken) {
          const key = `${r.scope}\0${r.day}`;
          if (!held.has(key)) held.set(key, count.get(r.scope, Date.parse(`${r.day}T00:00:00Z`))?.n ?? 0);
          const n = held.get(key)!;
          if (n >= DAY_MAX) continue;
          const who = `${key}\0${r.visitor}`;
          if (!heldVisitor.has(who)) heldVisitor.set(who, ofVisitor.get(r.scope, r.visitor, Date.parse(`${r.day}T00:00:00Z`))?.n ?? 0);
          const mine = heldVisitor.get(who)!;
          if (mine >= VISITOR_DAY_MAX) continue;
          heldVisitor.set(who, mine + 1);
          held.set(key, n + 1);
          const o = r.origin;
          insert.run(r.scope, r.day, r.at, r.visitor, r.path, o.refHost, o.source, o.medium, o.campaign, o.out, r.scraper ? 1 : 0);
        }
        db.query("DELETE FROM traffic_view WHERE at < ?1").run(now - KEEP_DAYS * 86_400_000);
      }),
    ),
  );
  buffer.splice(0, taken.length);
  forgetVisits(db);
  return taken.length;
}

/** The flush timer, for the server; `stop` writes what is left. */
export function createViewWriter(
  db: Database,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  flushMs: number = FLUSH_MS,
): { stop(): void } {
  const run = (): void => {
    try {
      flushViews(db);
    } catch (error) {
      log.warn("could not write page views", { error: String(error) });
    }
  };
  const tick = setInterval(() => during("views", run), flushMs);
  tick.unref();
  return {
    stop() {
      clearInterval(tick);
      run();
    },
  };
}
