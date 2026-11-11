/**
 * The forge's limits (`settings/limits.ts`), for a forge admin: listed with
 * their value and reason, and changed. Never by an agent, whatever it was
 * granted — a crew run that could raise its own ceilings would be the crew
 * deciding how much it may spend. Everyone else is told `not_found`.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  LIMITS,
  LIMIT_KEYS,
  isLimitKey,
  limitChanges,
  limitStates,
  setLimit,
  type LimitChange,
  type LimitDef,
  type LimitKey,
} from "../settings/limits.ts";

export interface LimitRow extends LimitDef {
  readonly key: LimitKey;
  readonly value: number;
  readonly isSet: boolean;
  readonly defaultValue: number;
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent"
    ? ok(actor)
    : err("not_found");
}

export function listLimits(
  app: App,
  actor: User | undefined,
): Result<{ limits: LimitRow[]; changes: LimitChange[] }, "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const states = limitStates(app.db, LIMIT_KEYS);
  return ok({
    limits: LIMIT_KEYS.map((key) => ({
      ...LIMITS[key],
      key,
      ...states.get(key)!,
    })),
    changes: limitChanges(app.db),
  });
}

export type ChangeLimitError =
  | { readonly kind: "not_found" }
  | { readonly kind: "no_such_limit" }
  | { readonly kind: "out_of_bounds"; readonly message: string };

/** Set `key` to `value`; `null` goes back to the default. */
export function changeLimit(
  app: App,
  actor: User | undefined,
  key: string,
  value: string | null,
): Result<{ key: LimitKey; from: number; to: number }, ChangeLimitError> {
  const who = admin(actor);
  if (!who.ok) return err({ kind: "not_found" });
  if (!isLimitKey(key)) return err({ kind: "no_such_limit" });
  const trimmed = value?.trim() ?? null;
  const n = trimmed === null ? null : /^\d{1,12}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const set = setLimit(app.db, key, n, who.value.id);
  if (!set.ok) return err(set.error);
  return ok({ key, ...set.value });
}
