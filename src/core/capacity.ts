/**
 * The forge's capacity, as numbers an admin changes while it runs: how many
 * crew runs and checks go at once, how many shards a check's test run uses,
 * and whether egress from a cell is refused or only reported. Each is read
 * where it is used, on every pick — never once at boot — so a change takes
 * effect on the next run, check or cell without a restart (#874). The
 * environment (`FORGE_CREW_CONCURRENCY` and the rest) stays the default a
 * forge boots with; a stored value overrides it until it is cleared.
 *
 * Every change is kept: who, when, from what to what (`capacityChanges`).
 * Pure data; authorization and the event are in `actions/capacity.ts`.
 */

import type { Database } from "bun:sqlite";

export type CapacityKey =
  | "crew.concurrency"
  | "checks.concurrency"
  | "checks.shards"
  | "cells.egress";

interface Definition {
  /** What the settings page and the API call it. */
  readonly label: string;
  /** The environment variable that is its boot default. */
  readonly env: string;
  /** Whole numbers in a range, or one of a few words. */
  readonly kind:
    | { readonly type: "count"; readonly min: number; readonly max: number }
    | { readonly type: "choice"; readonly values: readonly string[] };
  /** What it is when neither the store nor the environment says. */
  readonly fallback: string;
  readonly help: string;
}

export const CAPACITY: Record<CapacityKey, Definition> = {
  "crew.concurrency": {
    label: "Crew runs at once",
    env: "FORGE_CREW_CONCURRENCY",
    kind: { type: "count", min: 1, max: 16 },
    fallback: "2",
    help: "How many agent runs go at once. Lowering it lets running ones finish; the next one waits.",
  },
  "checks.concurrency": {
    label: "Checks at once",
    env: "FORGE_CHECKS_CONCURRENCY",
    kind: { type: "count", min: 1, max: 16 },
    fallback: "1",
    help: "How many repository checks run at once. Lowering it lets running ones finish; the next one waits.",
  },
  "checks.shards": {
    label: "Test shards per check",
    env: "FORGE_CHECK_SHARDS",
    kind: { type: "count", min: 1, max: 32 },
    fallback: "",
    help: "How many parallel shards a check's test run uses (handed to checks and crew shells as FORGE_CHECK_SHARDS). Empty: as many as the machine has cores.",
  },
  "cells.egress": {
    label: "Egress from cells",
    env: "FORGE_CELLS_EGRESS",
    kind: { type: "choice", values: ["enforce", "report"] },
    fallback: "enforce",
    help: "enforce refuses a host an app or check did not declare; report lets it through on 80 and 443 and lists it on the app's page. Takes effect on the next cell started.",
  },
};

export const CAPACITY_KEYS = Object.keys(CAPACITY) as CapacityKey[];

export function isCapacityKey(key: string): key is CapacityKey {
  return (CAPACITY_KEYS as string[]).includes(key);
}

/** Whether `value` is one `key` can hold. */
export function validCapacity(key: CapacityKey, value: string): boolean {
  const kind = CAPACITY[key].kind;
  if (kind.type === "choice") return kind.values.includes(value);
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= kind.min && n <= kind.max;
}

/** The boot default: the environment, when it holds a valid value. */
export function capacityDefault(key: CapacityKey): string {
  const env = process.env[CAPACITY[key].env]?.trim() ?? "";
  return env !== "" && validCapacity(key, env) ? env : CAPACITY[key].fallback;
}

/** The value stored by an admin, if any. */
export function storedCapacity(
  db: Database,
  key: CapacityKey,
): string | undefined {
  const row = db
    .query<
      { value: string },
      [string]
    >("SELECT value FROM forge_setting WHERE key = ?1")
    .get(key);
  return row !== null && validCapacity(key, row.value) ? row.value : undefined;
}

/** What `key` is now: the stored value, else the boot default. Read on every use. */
export function capacityValue(db: Database, key: CapacityKey): string {
  return storedCapacity(db, key) ?? capacityDefault(key);
}

/** A count setting as a number, `fallback` when it is empty (`checks.shards` unset). */
export function capacityCount(
  db: Database,
  key: CapacityKey,
  fallback: number,
): number {
  const n = Number(capacityValue(db, key));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The egress mode a cell starts with now. */
export function egressSetting(db: Database): "enforce" | "report" {
  return capacityValue(db, "cells.egress") === "report" ? "report" : "enforce";
}

/** What a check's commands and a crew shell are told: the shard count, when one is set. */
export function capacityEnv(db: Database): Record<string, string> {
  const shards = capacityValue(db, "checks.shards");
  return shards === "" ? {} : { FORGE_CHECK_SHARDS: shards };
}

export interface CapacityChange {
  readonly key: CapacityKey;
  readonly from: string;
  readonly to: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly at: string;
}

/**
 * Store `value` for `key` (`null` clears it back to the boot default) and
 * keep the change. Returns what it was and what it is now, as values in
 * effect — the boot default included — so the record reads as a person
 * saw it.
 */
export function setCapacity(
  db: Database,
  key: CapacityKey,
  value: string | null,
  actorId: string,
): { from: string; to: string } {
  const from = capacityValue(db, key);
  const at = new Date().toISOString();
  db.transaction(() => {
    if (value === null)
      db.query("DELETE FROM forge_setting WHERE key = ?1").run(key);
    else
      db.query(
        `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(key, value, actorId, at);
  })();
  const to = capacityValue(db, key);
  db.query(
    `INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(key, from, to, actorId, at);
  return { from, to };
}

/** The most recent changes, newest first. */
export function capacityChanges(db: Database, limit = 20): CapacityChange[] {
  return db
    .query<
      {
        key: string;
        from_value: string;
        to_value: string;
        actor_id: string;
        username: string | null;
        at: string;
      },
      [number]
    >(
      `SELECT c.key, c.from_value, c.to_value, c.actor_id, u.username, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        ORDER BY c.at DESC, c.rowid DESC LIMIT ?1`,
    )
    .all(limit)
    .filter((r) => isCapacityKey(r.key))
    .map((r) => ({
      key: r.key as CapacityKey,
      from: r.from_value,
      to: r.to_value,
      actorId: r.actor_id,
      actorName: r.username ?? "",
      at: r.at,
    }));
}
