/**
 * How many builders the crew may run at once, as home and the terminal say it:
 * the repositories' slots add up to a ceiling, `crew.concurrency` is the limit.
 */
import type { Database } from "bun:sqlite";
import { capacityValue } from "../core/capacity.ts";

/** The crew's concurrency now, or null when the setting holds no positive whole number. */
export function crewConcurrency(db: Database): number | null {
  // A database that never had settings (a bare fixture) has no limit to read.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'forge_setting'").get() === null) return null;
  const n = Number(capacityValue(db, "crew.concurrency"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The slots to show: the repositories' sum, never more than the crew runs at once. */
export function shownSlots(sum: number, cap: number | null): number {
  return cap === null ? sum : Math.min(sum, cap);
}
