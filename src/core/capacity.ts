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
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

export type CapacityKey =
  | "crew.concurrency"
  | "checks.concurrency"
  | "checks.shards"
  | "children.max"
  | "cells.egress"
  | "guard_new_accounts";

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
    help: "How many agent runs go at once. Empty: one per 3 GiB of memory above the forge's own 2 GiB, from the pod's limit, at least 2 and at most 16. Lowering it lets running ones finish; the next one waits.",
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
  "children.max": {
    label: "Forges this one may send",
    env: "FORGE_CHILDREN_MAX",
    kind: { type: "count", min: 1, max: 1000 },
    fallback: "",
    help: "How many hosted child forges this one holds at once. Empty: one per 512 MiB of memory above this forge's own 2 GiB, from the pod's limit. Raising it lets the New forge door open again at once.",
  },
  "cells.egress": {
    label: "Egress from cells",
    env: "FORGE_CELLS_EGRESS",
    kind: { type: "choice", values: ["enforce", "report"] },
    fallback: "enforce",
    help: "enforce refuses a host an app or check did not declare; report lets it through on 80 and 443 and lists it on the app's page. Takes effect on the next cell started.",
  },
  "guard_new_accounts": {
    label: "New-account repository guard",
    env: "FORGE_GUARD_NEW_ACCOUNTS",
    kind: { type: "choice", values: ["on", "off"] },
    fallback: "off",
    help: "on refuses repository creation and forks for accounts younger than 7 days (agents and admins are exempt); off leaves it to the usual permissions. Takes effect immediately. Replaces the hand-installed database trigger that used to do this with no toggle.",
  },
};

export const CAPACITY_KEYS = Object.keys(CAPACITY) as CapacityKey[];

/**
 * The words a refused repository creation carries when the new-account
 * guard stops it — the same words the hand-installed database trigger used,
 * so clients see no difference between the old trigger and the setting.
 */
export const NEW_ACCOUNT_GUARD_MESSAGE =
  "new accounts cannot create repositories yet";

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
  if (env !== "" && validCapacity(key, env)) return env;
  if (key === "children.max") return String(childrenForMemory(memoryLimitBytes()));
  if (key === "crew.concurrency") return String(crewForMemory(memoryLimitBytes()));
  return CAPACITY[key].fallback;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * One hosted child per 512 MiB of room above the forge's own 2 GiB (32 GiB
 * gives 60), never fewer than five: a small machine (a CI runner, a laptop)
 * still sends the forges the tests and a first owner expect (#1517).
 */
export function childrenForMemory(bytes: number): number {
  const n = Math.floor((bytes - 2 * GIB) / (512 * MIB));
  return Math.min(1000, Math.max(MIN_CHILDREN, Number.isFinite(n) ? n : MIN_CHILDREN));
}
const MIN_CHILDREN = 5;

/**
 * One crew run per 3 GiB of room above the forge's own 2 GiB (32 GiB gives
 * 10, 64 GiB the ceiling of 16), never fewer than two: a big machine runs
 * the crew it can hold without an override the sentinel then flags (#2548).
 */
export function crewForMemory(bytes: number): number {
  const n = Math.floor((bytes - 2 * GIB) / (3 * GIB));
  return Math.min(MAX_CREW, Math.max(MIN_CREW, Number.isFinite(n) ? n : MIN_CREW));
}
const MIN_CREW = 2;
const MAX_CREW = 16;

/** The pod's memory limit (cgroup v2, then v1), else the machine's memory. */
export function memoryLimitBytes(): number {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const n = Number(readFileSync(f, "utf8").trim());
      if (Number.isFinite(n) && n > 0 && n < totalmem()) return n;
    } catch {
      // No such cgroup file: try the next.
    }
  }
  return totalmem();
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
  return storedCapacity(db, key) ?? bootDefault(db, key);
}

/** What each service of a forge booted with, by its database. */
const booted = new WeakMap<Database, Map<CapacityKey, string>>();

/**
 * A service says what it booted with (a hosted forge's crew boots at one,
 * not the environment's fallback), so the default an admin is shown, and
 * goes back to, is the one actually in force.
 */
export function noteBooted(db: Database, key: CapacityKey, value: string): void {
  const map = booted.get(db) ?? new Map<CapacityKey, string>();
  map.set(key, value);
  booted.set(db, map);
}

/** The default in force: what the service booted with, else the environment's. */
export function bootDefault(db: Database, key: CapacityKey): string {
  return booted.get(db)?.get(key) ?? capacityDefault(key);
}

/**
 * A count setting as a number: an admin's value, else `fallback` — the
 * value the calling service booted with, which is the default in force.
 */
export function capacityCount(
  db: Database,
  key: CapacityKey,
  fallback: number,
): number {
  const stored = storedCapacity(db, key);
  const n = stored === undefined ? Number.NaN : Number(stored);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** How many hosted children this forge may hold now; read on every use. */
export function maxChildren(db: Database): number {
  return Number(capacityValue(db, "children.max"));
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
