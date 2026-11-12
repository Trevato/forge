/**
 * `traffic.returning` (#11265): whether this forge keeps a visitor id for its
 * own visitors. Stored in `forge_setting` under `traffic.returning`, every
 * change kept in `forge_setting_change`. Nothing stored reads as `off`, on every
 * forge: the owner chooses it for their own visitors, on Settings → Traffic. A
 * child's visitors are its own: nothing it collects reaches its host.
 */
import type { Database } from "bun:sqlite";
import { writeSetting } from "./limits.ts";

const STORE_KEY = "traffic.returning";

export function getReturning(db: Database): boolean {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(STORE_KEY);
  return row !== null && row.value === "on";
}

export function setReturning(db: Database, on: boolean, actorId: string): void {
  const from = getReturning(db);
  if (from === on) return;
  writeSetting(db, STORE_KEY, on ? "on" : "off", from ? "on" : "off", on ? "on" : "off", actorId);
}
