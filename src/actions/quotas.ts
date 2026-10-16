/**
 * Per-account quotas (`settings/quotas.ts`), for a forge admin who is a person.
 * Everyone else, an agent included, is told `not_found`.
 */

import type { App } from "../app.ts";
import {
  getQuotas,
  isQuotaKey,
  parseQuota,
  quotaChanges,
  setQuota,
  type QuotaChange,
  type QuotaKey,
  type Quotas,
} from "../settings/quotas.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type QuotaError = "not_found" | "invalid_quota" | "no_such_quota";

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

export function readQuotas(
  app: App,
  actor: User | undefined,
): Result<{ quotas: Quotas; changes: QuotaChange[] }, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok({ quotas: getQuotas(app.db), changes: quotaChanges(app.db) }) : who;
}

/** Apply `changes` (key → raw value) all or nothing: one bad value changes none. */
export function changeQuotas(
  app: App,
  actor: User | undefined,
  changes: Record<string, unknown>,
): Result<Quotas, QuotaError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const parsed: [QuotaKey, number | null][] = [];
  for (const [key, raw] of Object.entries(changes)) {
    if (!isQuotaKey(key)) return err("no_such_quota");
    const value = parseQuota(raw);
    if (!value.ok) return err(value.error);
    parsed.push([key, value.value]);
  }
  app.db.transaction(() => {
    for (const [key, value] of parsed) setQuota(app.db, key, value, who.value.id);
  })();
  return ok(getQuotas(app.db));
}
