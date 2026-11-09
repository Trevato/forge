/**
 * The forge's economics as stored: the profit slider's `position` (0–100,
 * default 50) and the margin on crew spend (`marginPct`, 0–500, default 0),
 * docs/PROFIT.md. Each is one `forge_setting` row, written through
 * `writeSetting` so every change is kept in `forge_setting_change` — who,
 * when, from what to what — like every limit. A stored value that is not a
 * whole number in range (hand-edited, or from a later build) reads as the
 * default, never as itself. Pure data; authorization is in
 * `actions/economics.ts`.
 */

import type { Database } from "bun:sqlite";
import {
  MARGIN_DEFAULT,
  MARGIN_MAX,
  POSITION_DEFAULT,
  POSITION_MAX,
  POSITION_MIN,
} from "../core/slider.ts";
import { writeSetting } from "./limits.ts";

export interface Economics {
  readonly position: number;
  readonly marginPct: number;
}

export type EconomicsKey = keyof Economics;

const STORE: Record<EconomicsKey, { key: string; min: number; max: number; fallback: number }> = {
  position: { key: "economics.position", min: POSITION_MIN, max: POSITION_MAX, fallback: POSITION_DEFAULT },
  marginPct: { key: "economics.margin_pct", min: 0, max: MARGIN_MAX, fallback: MARGIN_DEFAULT },
};

function stored(db: Database, name: EconomicsKey): number {
  const def = STORE[name];
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(def.key);
  if (row === null || !/^\d{1,4}$/.test(row.value)) return def.fallback;
  const n = Number(row.value);
  return n >= def.min && n <= def.max ? n : def.fallback;
}

/** Both numbers as they stand now: two point reads, on every use. */
export function getEconomics(db: Database): Economics {
  return { position: stored(db, "position"), marginPct: stored(db, "marginPct") };
}

/**
 * Write the numbers that differ from what stands, each with its change
 * kept. The caller has validated them (`parsePosition`, `parseMarginPct`);
 * an unchanged number writes nothing, so saving the form twice keeps one
 * change, not two.
 */
export function setEconomics(db: Database, next: Economics, actorId: string): void {
  const before = getEconomics(db);
  for (const name of ["position", "marginPct"] as const) {
    if (next[name] === before[name]) continue;
    writeSetting(db, STORE[name].key, String(next[name]), String(before[name]), String(next[name]), actorId);
  }
}

export interface EconomicsChange {
  readonly key: EconomicsKey;
  readonly from: string;
  readonly to: string;
  readonly actorName: string;
  readonly at: string;
}

/** The most recent changes to either number, newest first. */
export function economicsChanges(db: Database, limit = 20): EconomicsChange[] {
  const rows = db
    .query<
      { key: string; from_value: string; to_value: string; actor_name: string | null; at: string },
      [string, string, number]
    >(
      `SELECT c.key, c.from_value, c.to_value, u.username AS actor_name, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key IN (?1, ?2)
        ORDER BY c.at DESC, c.rowid DESC LIMIT ?3`,
    )
    .all(STORE.position.key, STORE.marginPct.key, limit);
  return rows.map((r) => ({
    key: r.key === STORE.position.key ? "position" : "marginPct",
    from: r.from_value,
    to: r.to_value,
    actorName: r.actor_name ?? "",
    at: r.at,
  }));
}
