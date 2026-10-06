/**
 * The forge's capacity, as its admins change it (`core/capacity.ts`): read
 * and written by a forge admin only, and never by an agent, whatever it was
 * granted — a crew run that could raise the crew's own concurrency would be
 * the crew deciding how much of the machine it gets. Everyone else is told
 * `not_found`, never that the door exists. Each change is kept and leaves
 * an event: the key, from what to what, and who.
 */

import type { App } from "../app.ts";
import {
  CAPACITY,
  CAPACITY_KEYS,
  capacityChanges,
  bootDefault,
  capacityValue,
  isCapacityKey,
  setCapacity,
  storedCapacity,
  validCapacity,
  type CapacityChange,
  type CapacityKey,
} from "../core/capacity.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface CapacityRow {
  readonly key: CapacityKey;
  readonly label: string;
  readonly help: string;
  readonly value: string;
  /** Where `value` comes from: an admin's setting, or the boot default. */
  readonly source: "setting" | "default";
  readonly default: string;
  readonly env: string;
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent"
    ? ok(actor)
    : err("not_found");
}

export function listCapacity(
  app: App,
  actor: User | undefined,
): Result<{ settings: CapacityRow[]; changes: CapacityChange[] }, "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok({
    settings: CAPACITY_KEYS.map((key) => ({
      key,
      label: CAPACITY[key].label,
      help: CAPACITY[key].help,
      value: capacityValue(app.db, key),
      source: storedCapacity(app.db, key) === undefined ? "default" : "setting",
      default: bootDefault(app.db, key),
      env: CAPACITY[key].env,
    })),
    changes: capacityChanges(app.db),
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
  "not_found" | "no_such_setting" | "invalid_value"
> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (!isCapacityKey(key)) return err("no_such_setting");
  const next = value === null ? null : value.trim();
  if (next !== null && next !== "" && !validCapacity(key, next))
    return err("invalid_value");
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
