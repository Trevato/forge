/**
 * Every limit a forge's owner can hit, in one place: its name, default,
 * bounds and the one sentence that says why it is there. The code that
 * enforces a limit asks `limitValue` on every use, so a change on
 * `/admin/limits` governs the next request and never needs a restart.
 *
 * Values live in `forge_setting` (like capacity, `core/capacity.ts`); the
 * two crew/check concurrency limits *are* capacity settings, so they are
 * read and written there and listed here with the bounds capacity holds —
 * one stored value, one place that says what it may be. Every change is
 * kept in `forge_setting_change`: who, when, from what to what.
 * Pure data; authorization is in `actions/limits.ts`.
 */

import type { Database } from "bun:sqlite";
import {
  CAPACITY,
  bootDefault,
  capacityValue,
  setCapacity,
  type CapacityKey,
} from "../core/capacity.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type LimitKey =
  | "crew.concurrency"
  | "checks.concurrency"
  | "agent.budget_max_usd"
  | "subscription.budget_max_usd"
  | "app.members_max"
  | "front.pinned_max"
  | "front.hidden_max"
  | "share.daily_max"
  | "signin.per_account"
  | "signin.per_source"
  | "signin.per_forge"
  | "signup.per_source"
  | "signup.per_forge"
  | "signup.per_source_hour"
  | "signup.per_forge_hour"
  | "guest.forks_per_day"
  | "guest.forks_forge_per_day"
  | "guest.pulls_per_day"
  | "forges.per_person"
  | "forges.wakes_per_person_hour"
  | "forges.storage_mb"
  | "guest.storage_mb"
  | "guest.fork_storage_mb"
  | "guest.cooldown_minutes"
  | "api.anonymous_per_source"
  | "model_review.auto"
  | "model_review.min_landed"
  | "model_review.slack_pct";

export interface LimitDef {
  readonly label: string;
  readonly unit: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** One sentence: why the limit is there. */
  readonly reason: string;
}

function capacityLimit(key: CapacityKey, unit: string, reason: string): LimitDef {
  const kind = CAPACITY[key].kind;
  if (kind.type !== "count") throw new Error(`${key} is not a count`);
  return {
    label: CAPACITY[key].label,
    unit,
    default: Number(CAPACITY[key].fallback),
    min: kind.min,
    max: kind.max,
    reason,
  };
}

export const LIMITS: Record<LimitKey, LimitDef> = {
  "crew.concurrency": capacityLimit(
    "crew.concurrency",
    "runs",
    "The crew shares one machine; more runs at once slow every run and every page.",
  ),
  "checks.concurrency": capacityLimit(
    "checks.concurrency",
    "checks",
    "A check runs a whole test suite; more at once starve the web process of CPU.",
  ),
  "agent.budget_max_usd": {
    label: "Crew member budget ceiling",
    unit: "dollars",
    default: 100,
    min: 1,
    max: 1_000_000,
    reason: "A crew member's per-run budget is spent unattended, so what one run may cost has a top.",
  },
  "subscription.budget_max_usd": {
    label: "Pool account budget ceiling",
    unit: "dollars",
    default: 100_000,
    min: 1,
    max: 100_000_000,
    reason: "A sealed account's whole-life budget is a promise about real money, so a typo cannot make it unbounded.",
  },
  "app.members_max": {
    label: "People named on one app",
    unit: "people",
    default: 100,
    min: 1,
    max: 10_000,
    reason: "The member list is read on every request to the app, so it stays short enough to scan.",
  },
  "front.pinned_max": {
    label: "Pinned repositories on the front page",
    unit: "repositories",
    default: 12,
    min: 1,
    max: 100,
    reason: "Pins sit above the fold; past a dozen they stop being picks.",
  },
  "front.hidden_max": {
    label: "Hidden repositories on the front page",
    unit: "repositories",
    default: 200,
    min: 1,
    max: 10_000,
    reason: "The hidden list is checked while the front page is ranked, so it is kept bounded.",
  },
  "share.daily_max": {
    label: "Shares delivered to one person a day",
    unit: "shares",
    default: 5,
    min: 1,
    max: 1_000,
    reason: "A person's feed is theirs: shares past the day's allowance wait instead of crowding it out.",
  },
  "signin.per_account": {
    label: "Sign-in attempts per account from one source a minute",
    unit: "attempts",
    default: 20,
    min: 1,
    max: 1_000,
    reason: "Every attempt costs a password hash, and a guesser gets only so many tries at one account from one source, so one stranger cannot lock the owner out. A guesser spread over many sources is bounded only by the per-forge limit.",
  },
  "signin.per_source": {
    label: "Sign-in attempts per source a minute",
    unit: "attempts",
    default: 60,
    min: 1,
    max: 10_000,
    reason: "One source trying account after account is guessing, and each try costs a hash, so a source has a ceiling of its own.",
  },
  "signin.per_forge": {
    label: "Sign-in attempts per forge a minute",
    unit: "attempts",
    default: 200,
    min: 1,
    max: 100_000,
    reason: "Spread across many accounts, guessing still burns CPU on hashes, so the forge as a whole has a ceiling.",
  },
  "signup.per_source": {
    label: "Sign-ups per source a minute",
    unit: "sign-ups",
    default: 5,
    min: 1,
    max: 1_000,
    reason: "Every sign-up costs a password hash and an account, and one source has no need to make many.",
  },
  "signup.per_forge": {
    label: "Sign-ups per forge a minute",
    unit: "sign-ups",
    default: 60,
    min: 1,
    max: 100_000,
    reason: "Spread across many sources, sign-ups still cost hashes and accounts, so the forge as a whole has a ceiling.",
  },
  "signup.per_source_hour": {
    label: "New accounts per source an hour",
    unit: "accounts",
    default: 5,
    min: 1,
    max: 10_000,
    reason: "One address has no need of many accounts, and an account is what every other guest limit is counted on. Never less than the per-minute limit.",
  },
  "signup.per_forge_hour": {
    label: "New accounts per forge an hour",
    unit: "accounts",
    default: 60,
    min: 1,
    max: 100_000,
    reason: "Many addresses together still make accounts, so the whole forge has a ceiling that holds while an admin looks.",
  },
  "guest.forks_per_day": {
    label: "Forks one guest may make a day",
    unit: "forks",
    default: 3,
    min: 0,
    max: 1_000,
    reason: "A guest's fork is for one contribution, and deleting one makes no room in the count.",
  },
  "guest.forks_forge_per_day": {
    label: "Guest forks on the whole forge a day",
    unit: "forks",
    default: 50,
    min: 0,
    max: 100_000,
    reason: "Many guests together can fill a disk one fork at a time, so their forks have a ceiling across the forge.",
  },
  "guest.pulls_per_day": {
    label: "Pull requests one guest may send a day",
    unit: "pulls",
    default: 5,
    min: 0,
    max: 1_000,
    reason: "Every pull asks a person to read it, so a guest's pulls have a daily count.",
  },
  "forges.per_person": {
    label: "Hosted forges one person may own",
    unit: "forges",
    default: 3,
    min: 1,
    max: 1_000,
    reason: "Every hosted forge holds a database and its repositories on this machine's disk; site admins are not counted.",
  },
  "forges.wakes_per_person_hour": {
    label: "Wakes per person per hour",
    unit: "wakes",
    default: 30,
    min: 1,
    max: 10_000,
    reason: "Waking a sleeping forge starts a process on this machine; a person who wakes theirs too often is asked to wait.",
  },
  "forges.storage_mb": {
    label: "Storage a person can hold in hosted forges",
    unit: "MB",
    default: 1_000,
    min: 1,
    max: 10_000_000,
    reason: "A hosted forge keeps its data here even asleep, so what one person's forges hold in all has a ceiling.",
  },
  "guest.storage_mb": {
    label: "Storage one guest may hold in their forks",
    unit: "MB",
    default: 100,
    min: 1,
    max: 1_000_000,
    reason: "What a guest pushes stays on this machine's disk until someone deletes it.",
  },
  "guest.fork_storage_mb": {
    label: "Storage one guest fork may hold",
    unit: "MB",
    default: 50,
    min: 1,
    max: 1_000_000,
    reason: "A fork borrows its parent's history, so a change that needs more room than this is not a change to review.",
  },
  "guest.cooldown_minutes": {
    label: "Minutes a new guest waits before a first fork or pull",
    unit: "minutes",
    default: 10,
    min: 0,
    max: 100_000,
    reason: "An account made only to send something is slowed; reading and commenting start at once.",
  },
  "api.anonymous_per_source": {
    label: "API reads without a token per source a minute",
    unit: "reads",
    default: 300,
    min: 1,
    max: 100_000,
    reason: "A token's reads are counted by the token; a stranger's have no token to count, so one source reading without one has a ceiling of its own.",
  },
  "model_review.auto": {
    label: "Weekly model review applies a cheaper model on its own",
    unit: "0 asks first, 1 applies",
    default: 0,
    min: 0,
    max: 1,
    reason: "A step to a cheaper model is undone if quality falls, but only the owner says whether it may happen unasked; a step up always asks.",
  },
  "model_review.min_landed": {
    label: "Landed pulls a model needs before the weekly review judges it",
    unit: "pulls",
    default: 8,
    min: 3,
    max: 1_000,
    reason: "A handful of pulls is luck, not a rate, so a smaller sample changes nothing.",
  },
  "model_review.slack_pct": {
    label: "Red-check rate a cheaper model may be worse by",
    unit: "percentage points",
    default: 10,
    min: 0,
    max: 100,
    reason: "Past this the weekly review undoes its own change, so quality is the bar the saving is held to.",
  },
};

export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];

export function isLimitKey(key: string): key is LimitKey {
  return Object.hasOwn(LIMITS, key);
}

/** Which limits are capacity settings and so stored there. */
function capacityKey(key: LimitKey): CapacityKey | undefined {
  return key === "crew.concurrency" || key === "checks.concurrency"
    ? key
    : undefined;
}

function storeKey(key: LimitKey): string {
  return `limit.${key}`;
}

/** Whether `n` is a whole number inside `key`'s bounds. */
export function validLimit(key: LimitKey, n: number): boolean {
  const def = LIMITS[key];
  return Number.isInteger(n) && n >= def.min && n <= def.max;
}

/** The sentence that names a limit's bounds, for a refusal. */
export function limitBounds(key: LimitKey): string {
  const def = LIMITS[key];
  return `${def.label} is a whole number from ${def.min} to ${def.max}`;
}

function stored(db: Database, key: LimitKey): number | undefined {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM forge_setting WHERE key = ?1",
    )
    .get(storeKey(key));
  if (row === null || !/^\d+$/.test(row.value)) return undefined;
  const n = Number(row.value);
  return validLimit(key, n) ? n : undefined;
}

/** The value in force when nobody has set one. */
export function limitDefault(db: Database, key: LimitKey): number {
  const cap = capacityKey(key);
  if (cap !== undefined) {
    const n = Number(bootDefault(db, cap));
    return validLimit(key, n) ? n : LIMITS[key].default;
  }
  return LIMITS[key].default;
}

/** What `key` is now. Read on every use, never once at boot. */
export function limitValue(db: Database, key: LimitKey): number {
  const cap = capacityKey(key);
  if (cap !== undefined) {
    const n = Number(capacityValue(db, cap));
    return validLimit(key, n) ? n : limitDefault(db, key);
  }
  return stored(db, key) ?? LIMITS[key].default;
}

/** Whether an admin has set `key` (rather than it being the default). */
export function limitIsSet(db: Database, key: LimitKey): boolean {
  const cap = capacityKey(key);
  if (cap !== undefined)
    return (
      db
        .query("SELECT 1 FROM forge_setting WHERE key = ?1")
        .get(cap) !== null
    );
  return stored(db, key) !== undefined;
}

export type LimitError = {
  readonly kind: "out_of_bounds";
  readonly message: string;
};

/**
 * The one write path for a forge setting kept under its own `forge_setting`
 * key: set it (`null` removes it) and keep the change — who, when, from what
 * to what — in `forge_setting_change`, in one transaction. `from` and `to`
 * are the words kept for the change, which for a removed value is whatever
 * stands in its place.
 */
export function writeSetting(
  db: Database,
  key: string,
  value: string | null,
  from: string,
  to: string,
  actorId: string,
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    if (value === null) db.query("DELETE FROM forge_setting WHERE key = ?1").run(key);
    else
      db.query(
        `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(key, value, actorId, at);
    db.query(
      `INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).run(key, from, to, actorId, at);
  })();
}

/**
 * Set `key` to `value` (`null` goes back to the default) and keep the
 * change. A value outside the bounds is refused with the bounds named.
 */
export function setLimit(
  db: Database,
  key: LimitKey,
  value: number | null,
  actorId: string,
): Result<{ from: number; to: number }, LimitError> {
  if (value !== null && !validLimit(key, value))
    return err({ kind: "out_of_bounds", message: limitBounds(key) });
  const from = limitValue(db, key);
  const cap = capacityKey(key);
  if (cap !== undefined) {
    setCapacity(db, cap, value === null ? null : String(value), actorId);
    return ok({ from, to: limitValue(db, key) });
  }
  writeSetting(
    db,
    storeKey(key),
    value === null ? null : String(value),
    String(from),
    String(value ?? LIMITS[key].default),
    actorId,
  );
  return ok({ from, to: limitValue(db, key) });
}

export interface LimitChange {
  readonly key: LimitKey;
  readonly from: string;
  readonly to: string;
  readonly actorName: string;
  readonly at: string;
}

/** The most recent changes to any listed limit, newest first. */
export function limitChanges(db: Database, limit = 20): LimitChange[] {
  const marks = LIMIT_KEYS.map((_, i) => `?${i + 1}`).join(", ");
  const rows = db
    .query<
      {
        key: string;
        from_value: string;
        to_value: string;
        username: string | null;
        at: string;
      },
      string[]
    >(
      `SELECT c.key, c.from_value, c.to_value, u.username, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key IN (${marks})
        ORDER BY c.at DESC, c.rowid DESC
        LIMIT ${Math.trunc(limit)}`,
    )
    .all(...LIMIT_KEYS.map(storedChangeKey));
  return rows.map((r) => ({
    key: fromChangeKey(r.key),
    from: r.from_value,
    to: r.to_value,
    actorName: r.username ?? "",
    at: r.at,
  }));
}

/** The key a change is kept under: capacity's own, or `limit.` + the key. */
function storedChangeKey(key: LimitKey): string {
  return capacityKey(key) ?? storeKey(key);
}

function fromChangeKey(key: string): LimitKey {
  return (key.startsWith("limit.") ? key.slice(6) : key) as LimitKey;
}
