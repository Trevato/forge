/**
 * When a person last loaded `/`, in epoch milliseconds. `noteVisit` answers
 * the visit before this one and writes the new time at most once a minute,
 * so a reload storm is one cheap indexed read.
 */

import type { Database } from "bun:sqlite";
import { quietly } from "./write_clock.ts";

export const VISIT_WRITE_GAP_MS = 60 * 1000;

export function lastVisit(db: Database, userId: string): number | undefined {
  return db.query<{ at: number }, [string]>("SELECT at FROM home_visit WHERE user_id = ?1").get(userId)?.at;
}

/** The time of the visit before this one, if any; records this one unless it is within a minute of it. */
export function noteVisit(db: Database, userId: string, now: number): number | undefined {
  const before = lastVisit(db, userId);
  if (before === undefined || now - before >= VISIT_WRITE_GAP_MS)
    quietly(db, () =>
      db
        .query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at")
        .run(userId, now),
    );
  return before;
}

/**
 * Whether a request is a person opening the page: not a prefetch or preview
 * (`Sec-Purpose` / `Purpose`), and, when the browser says what it is fetching,
 * a document. A client that sends neither header (curl, the terminal) counts.
 */
export function isNavigation(req: Request): boolean {
  const purpose = `${req.headers.get("sec-purpose") ?? ""} ${req.headers.get("purpose") ?? ""}`.toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender") || purpose.includes("preview")) return false;
  const dest = req.headers.get("sec-fetch-dest");
  return dest === null || dest === "document";
}
