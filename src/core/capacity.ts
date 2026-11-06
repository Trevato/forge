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
import { availableParallelism, totalmem } from "node:os";

export type CapacityKey =
  | "crew.concurrency"
  | "checks.concurrency"
  | "checks.shards"
  | "queue.depth"
  | "queue.batch"
  | "children.max"
  | "cells.egress"
  | "children.modelEgress"
  | "guard_new_accounts"
  | "signin.edge"
  | "slots.smallShare"
  | "polish.capMinutes"
  | "pace.floor";

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
  /** The default from the pod's CPUs, in place of `fallback` (#2549). */
  readonly sized?: (cpus: number) => number;
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
    sized: (cpus) => checksForCpus(cpus),
    help: "How many repository checks run at once. Lowering it lets running ones finish; the next one waits. Empty: the pod's CPUs over three per shard (shards × 3), from 1 to 16 — 80 CPUs give 6.",
  },
  "checks.shards": {
    label: "Test shards per check",
    env: "FORGE_CHECK_SHARDS",
    kind: { type: "count", min: 1, max: 32 },
    fallback: "1",
    sized: (cpus) => shardsForCpus(cpus),
    help: "How many parallel shards a check's test run uses (handed to checks and crew shells as FORGE_CHECK_SHARDS). Empty: the pod's CPUs, at most 4 — and, in a check, no more than its cell holds.",
  },
  "queue.depth": {
    label: "Merge queue candidates at once",
    env: "FORGE_QUEUE_DEPTH",
    kind: { type: "count", min: 1, max: 4 },
    fallback: "2",
    help: "How many merge-queue candidates of one repository gate at once, each on top of the one before: while one gates on main the next gates on it, and lands right after it if both are green. 1 gates one candidate at a time. A gate beyond the first takes a free check slot only, never one of the two kept for pull checks.",
  },
  "queue.batch": {
    label: "Merge queue batch size",
    env: "FORGE_QUEUE_BATCH",
    kind: { type: "count", min: 1, max: 32 },
    fallback: "8",
    help: "The most pulls one merge-queue candidate carries. A bigger batch lands more pulls per green gate; a red one costs more search gates to find its culprit (one bad pull in 16 is found in two rounds, at most √16 = 4 gates each). The queue starts each line here, halves the batch after a red gate and doubles it back after two green gates in a row, never past this. Read on every sweep.",
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
  "children.modelEgress": {
    label: "Model provider a child forge's cell may reach",
    env: "FORGE_CHILDREN_MODEL_EGRESS",
    kind: { type: "choice", values: ["off", "openrouter"] },
    fallback: "off",
    help: "off keeps a child forge's cell to its parent alone; openrouter also lets it reach openrouter.ai on 443, so the child's crew can call its model on the child's own key. Nothing else opens, and the cell enforces this even when cells.egress is report. Takes effect on the next child cell started.",
  },
  "guard_new_accounts": {
    label: "New-account repository guard",
    env: "FORGE_GUARD_NEW_ACCOUNTS",
    kind: { type: "choice", values: ["on", "off"] },
    fallback: "off",
    help: "on refuses repository creation and forks for accounts younger than 7 days (agents and admins are exempt); off leaves it to the usual permissions. Takes effect immediately. Replaces the hand-installed database trigger that used to do this with no toggle.",
  },
  "signin.edge": {
    label: "Sign in through the platform edge",
    env: "FORGE_SIGNIN_EDGE",
    kind: { type: "choice", values: ["on", "off"] },
    fallback: "on",
    help: "on reads the platform edge's identity headers (when the forge has an edge secret) and offers its sign-in; off ignores them on every door, so people sign in with the forge's own methods — password and passkey. Accounts the edge made keep their names but have no password until they set one. Takes effect on the next request.",
  },
  "slots.smallShare": {
    label: "Builder slots small issues may hold (%)",
    env: "FORGE_SLOTS_SMALL_SHARE",
    kind: { type: "count", min: 0, max: 100 },
    fallback: "30",
    help: "The most of a repository's builder slots that tests-only and small-addition issues (\"A test pins …\", or a label test, tests, tests-only or small) hold at once, as a percent rounded up: 30 lets 2 of 5 slots go to them. At the cap a small issue is skipped and the slot goes to the next issue in the Next up order; a ranked small issue is still taken. 100 lifts the cap; 0 starts none. Read on every pick.",
  },
  "polish.capMinutes": {
    label: "Run time a polish issue may take (minutes)",
    env: "FORGE_POLISH_CAP_MINUTES",
    kind: { type: "count", min: 1, max: 1440 },
    fallback: "60",
    help: "An issue labelled polish is small work: a builder run on it that has gone this many minutes is stopped, not extended, and the issue gets one comment saying what is left. Read on every tick.",
  },
  "pace.floor": {
    label: "Slots the pace always leaves reviews and assigned work",
    env: "FORGE_PACE_FLOOR",
    kind: { type: "count", min: 1, max: 16 },
    fallback: "2",
    help: "While the week's pace allows any slots, this many reviews and issues a person assigned may run at once, apart from the crew's own picks, however hard the pace slows them; also the fewest slots a fast burn slows a repository to. At the reserve's wall everything waits. Read on every pump.",
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
export function capacityDefault(key: CapacityKey, cpus?: number): string {
  const env = explicitDefault(key);
  if (env !== undefined) return env;
  const sized = CAPACITY[key].sized;
  if (sized !== undefined) return String(sized(cpus ?? cpuLimit()));
  if (key === "children.max") return String(childrenForMemory(memoryLimitBytes()));
  if (key === "crew.concurrency") return String(crewForMemory(memoryLimitBytes()));
  return CAPACITY[key].fallback;
}

/** The environment's value for `key`, when it holds a valid one. */
function explicitDefault(key: CapacityKey): string | undefined {
  const env = process.env[CAPACITY[key].env]?.trim() ?? "";
  return env !== "" && validCapacity(key, env) ? env : undefined;
}

/** Most shards a check takes by default: past four, a test run waits on git, not CPU. */
const SHARDS_DEFAULT_MAX = 4;
/** CPUs a shard is given by default: its bun test, the git children it starts, and the forge it boots. */
const CPUS_PER_SHARD = 3;

/** Shards per check by default: `min(4, cpus)`, at least one. 80 CPUs give 4; 2 give 2. */
export function shardsForCpus(cpus: number): number {
  const n = Math.floor(cpus);
  return Number.isFinite(n) ? Math.max(1, Math.min(SHARDS_DEFAULT_MAX, n)) : 1;
}

/**
 * Checks at once by default: `floor(cpus / (shards × 3))`, held to 1–16, so
 * every check's shards have three CPUs each. 80 CPUs: 4 shards, 80 / 12 = 6
 * checks; 16 CPUs: 1; 4 CPUs: 4 shards, 4 / 12 → 1 (#2549).
 */
export function checksForCpus(cpus: number, shards = shardsForCpus(cpus)): number {
  const n = Math.floor(cpus / (shards * CPUS_PER_SHARD));
  return Number.isFinite(n) ? Math.max(1, Math.min(16, n)) : 1;
}

let cpusForTest: number | undefined;

/**
 * A test's CPU count in place of the pod's, so a default sized from it is
 * the same on a laptop and an 80-core runner; `undefined` reads the pod again.
 */
export function provideCpusForTest(cpus: number | undefined): void {
  cpusForTest = cpus;
}

/**
 * The pod's CPU limit: cgroup v2 `cpu.max` ("quota period", in µs), rounded
 * down and never below one, else `os.availableParallelism()` — "max" (no
 * quota), an unreadable file or anything not two numbers falls back. Never
 * more than the machine has.
 */
export function cpuLimit(file = "/sys/fs/cgroup/cpu.max"): number {
  if (cpusForTest !== undefined) return cpusForTest;
  const machine = availableParallelism();
  try {
    const [quota, period] = readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
    if (quota !== undefined && period !== undefined && quota > 0 && period > 0)
      return Math.max(1, Math.min(machine, Math.floor(quota / period)));
  } catch {
    // No cgroup v2 CPU controller here: the machine's count.
  }
  return machine;
}

/**
 * The share of a check cell's declared CPUs the workers are sized to. The
 * cell's watchdog (`src/apps/contain.ts`) stops a check whose tree averages
 * more than `check.limits.cpus` cores over 30 s, and a worker is more than
 * one core at its peaks (Bun's own threads, git children, a booted forge):
 * one worker per declared CPU averaged 16.1 of 16 and stopped main (#2161).
 */
export const CELL_CPU_SHARE = 3 / 4;

/**
 * The CPUs the gate sizes its workers to: the machine's, held under
 * {@link CELL_CPU_SHARE} of the cell's CPU limit (`FORGE_CELL_CPUS`) when
 * there is one, at least one. `availableParallelism()` sees the host, not
 * the cell: the cell is a watchdog, not a CPU quota the process can read.
 */
export function workerCpus(machine: number, declared: number | undefined): number {
  if (declared === undefined || !Number.isFinite(declared) || declared <= 0) return machine;
  return Math.max(1, Math.min(machine, Math.floor(declared * CELL_CPU_SHARE)));
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
 * The ceiling `key` is held under: its default in force, when an admin's
 * stored count is below it; null for a choice, an unset key or a value at
 * or above the ceiling. A crew concurrency lowered at runtime holds the
 * crew back, and this is how a page can say so.
 */
export function belowCeiling(db: Database, key: CapacityKey): { value: number; ceiling: number } | null {
  if (CAPACITY[key].kind.type !== "count") return null;
  const stored = storedCapacity(db, key);
  const ceiling = Number(bootDefault(db, key));
  if (stored === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return null;
  return Number(stored) < ceiling ? { value: Number(stored), ceiling } : null;
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

/** The slots the pace leaves reviews and assigned work (`pace.floor`). */
export function paceFloor(db: Database): number {
  return Number(capacityValue(db, "pace.floor"));
}

/** How many hosted children this forge may hold now; read on every use. */
export function maxChildren(db: Database): number {
  return Number(capacityValue(db, "children.max"));
}

/** The egress mode a cell starts with now. */
export function egressSetting(db: Database): "enforce" | "report" {
  return capacityValue(db, "cells.egress") === "report" ? "report" : "enforce";
}

/** The model provider hosts a child forge's cell may reach now: none unless an admin chose one. */
export function childModelHosts(db: Database): readonly string[] {
  return capacityValue(db, "children.modelEgress") === "openrouter" ? ["openrouter.ai:443"] : [];
}

/** How many merge-queue candidates of one repository gate at once (#4053). */
export function queueDepth(db: Database): number {
  return Number(capacityValue(db, "queue.depth"));
}

/** The most pulls one merge-queue candidate carries (#6674); the line adapts below it. */
export function queueBatch(db: Database): number {
  return Number(capacityValue(db, "queue.batch"));
}

/** The percent of builder slots small issues may hold (#7571). */
export function smallShare(db: Database): number {
  return Number(capacityValue(db, "slots.smallShare"));
}

/** The minutes of run time a polish issue may take before its run is stopped (#8852). */
export function polishCapMinutes(db: Database): number {
  return Number(capacityValue(db, "polish.capMinutes"));
}

/** Whether the platform edge's identity is read at all; on every request. */
export function edgeSigninOn(db: Database): boolean {
  return capacityValue(db, "signin.edge") !== "off";
}

/**
 * What a check's commands and a crew shell are told: the shard count in
 * force. An admin's value or the environment's is passed as it is; the
 * default is sized from `cpus` — a check passes what its cell holds, so a
 * small cell is never told the pod's count.
 */
export function capacityEnv(db: Database, cpus?: number): Record<string, string> {
  const shards =
    storedCapacity(db, "checks.shards") ??
    explicitDefault("checks.shards") ??
    String(shardsForCpus(cpus ?? cpuLimit()));
  return { FORGE_CHECK_SHARDS: shards };
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
