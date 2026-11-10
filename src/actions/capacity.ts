/**
 * The forge's capacity, as its admins change it (`core/capacity.ts`): read
 * and written by a forge admin only, and never by an agent, whatever it was
 * granted — a crew run that could raise the crew's own concurrency would be
 * the crew deciding how much of the machine it gets. Everyone else is told
 * `not_found`, never that the door exists. Each change is kept and leaves
 * an event: the key, from what to what, and who.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import {
  CAPACITY,
  CAPACITY_KEYS,
  capacityChanges,
  bootDefault,
  isCapacityKey,
  setCapacity,
  storedCapacity,
  validCapacity,
  type CapacityChange,
  type CapacityKey,
  effectiveCapacity,
  followsSpeed,
} from "../core/capacity.ts";
import type { EgressTotal } from "../apps/egress.ts";
import {
  egressTotalsFor,
  liveCounters,
  npmBytesFor,
  npmTopRepoFor,
  type ProcessCounters,
} from "../spawn/process_counters.ts";
import { getRepoById } from "../core/repos.ts";
import { selfSwapState, type SelfSwap } from "../release/swap.ts";
import { signinReach, signsInWithoutEdge } from "../core/accounts.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The six guards a caller may set by `key`: the MCP tool's enum and the terminal's `e`. */
export const SETTABLE_CAPACITY = [
  "crew.concurrency",
  "checks.concurrency",
  "checks.shards",
  "cells.egress",
  "guard_new_accounts",
  "signin.edge",
] as const satisfies readonly CapacityKey[];

export interface CapacityRow {
  readonly key: CapacityKey;
  readonly label: string;
  readonly help: string;
  readonly value: string;
  /** Where `value` comes from: an admin's setting, or the boot default. */
  readonly source: "setting" | "default" | "derived";
  readonly default: string;
  readonly env: string;
  /** For a setting away from its default: when and by whom it was set. */
  readonly changed?: { readonly at: string; readonly by: string };
}

/**
 * What the egress proxies received over the last hour (#7546), the npm
 * registry first: a warm bun cache keeps `npmBytesLastHour` near zero, so a
 * figure in the hundreds of megabytes is the cache gone cold again (#7541).
 */
export interface EgressHour {
  readonly npmBytesLastHour: number;
  /**
   * The repository whose contained installs the registry sent most this
   * hour (#8382), as `owner/name`, attributed by the cell that fetched;
   * null when no metered install fetched, or its repository is gone.
   */
  readonly npmTopRepoLastHour: { readonly repo: string; readonly bytes: number } | null;
  /** The ten destinations that sent most this hour, with their totals since boot. */
  readonly destinations: readonly EgressTotal[];
}

/** This hour's egress as `app` may read it: none of it on a hosted child (#10517). */
export function egressHour(app: App, now = Date.now(), read: ProcessCounters = liveCounters): EgressHour {
  const top = npmTopRepoFor(app, now, read);
  const repo = top === undefined ? undefined : getRepoById(app.db, top.repoId);
  return {
    npmBytesLastHour: npmBytesFor(app, now, read),
    npmTopRepoLastHour:
      top === undefined || repo === undefined ? null : { repo: `${repo.ownerName}/${repo.name}`, bytes: top.bytes },
    destinations: egressTotalsFor(app, now, read).slice(0, 10),
  };
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent"
    ? ok(actor)
    : err("not_found");
}

/** Who set `key` and when, only while its stored value is not the default. */
export function changedOf(db: Database, key: CapacityKey): { changed?: { at: string; by: string } } {
  const value = storedCapacity(db, key);
  if (value === undefined || value === bootDefault(db, key)) return {};
  const row = db
    .query<{ updated_at: string; username: string | null }, [string]>(
      "SELECT s.updated_at, u.username FROM forge_setting s LEFT JOIN user u ON u.id = s.updated_by WHERE s.key = ?1",
    )
    .get(key);
  return row === null ? {} : { changed: { at: row.updated_at, by: row.username ?? "someone" } };
}

export function listCapacity(
  app: App,
  actor: User | undefined,
): Result<
  { settings: CapacityRow[]; changes: CapacityChange[]; egress: EgressHour; selfSwap: SelfSwap },
  "not_found"
> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok({
    settings: CAPACITY_KEYS.map((key) => ({
      key,
      label: CAPACITY[key].label,
      help: CAPACITY[key].help,
      value: effectiveCapacity(app.db, key),
      source: followsSpeed(app.db, key) ? "derived" : storedCapacity(app.db, key) === undefined ? "default" : "setting",
      default: bootDefault(app.db, key),
      env: CAPACITY[key].env,
      ...changedOf(app.db, key),
    })),
    changes: capacityChanges(app.db),
    egress: egressHour(app),
    selfSwap: selfSwapState(app.config.selfSwap === true),
  });
}

/**
 * A dry run of switching `signin.edge` off: who could no longer sign in, and
 * whether that includes the admin asking (which refuses the switch). Changes
 * nothing.
 */
export function edgeOffDryRun(
  db: Database,
  actor: User | undefined,
): Result<
  { total: number; own: number; lockedOut: { username: string; isAdmin: boolean }[]; youLockedOut: boolean; allowed: boolean },
  "not_found"
> {
  const who = admin(actor);
  if (!who.ok) return who;
  const reach = signinReach(db);
  const youLockedOut = !signsInWithoutEdge(db, who.value.id);
  return ok({
    total: reach.total,
    own: reach.own,
    lockedOut: reach.stranded.map((a) => ({ username: a.username, isAdmin: a.isAdmin })),
    youLockedOut,
    allowed: !youLockedOut,
  });
}

/** Set `key` to `value`; `null` or `""` goes back to the boot default. */
export function changeCapacity(
  app: App,
  actor: User | undefined,
  key: string,
  value: string | null,
): Result<
  { key: CapacityKey; from: string; to: string },
  "not_found" | "no_such_setting" | "invalid_value" | "no_credential"
> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (!isCapacityKey(key)) return err("no_such_setting");
  const next = value === null ? null : value.trim();
  if (next !== null && next !== "" && !validCapacity(key, next))
    return err("invalid_value");
  if (key === "signin.edge" && next === "off" && !signsInWithoutEdge(app.db, who.value.id))
    return err("no_credential");
  const changed = setCapacity(
    app.db,
    key,
    next === "" ? null : next,
    who.value.id,
  );
  app.bus.append({
    kind: "capacity.changed",
    actorId: who.value.id,
    payload: { key, from: changed.from, to: changed.to },
  });
  return ok({ key, ...changed });
}
