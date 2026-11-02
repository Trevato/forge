/**
 * The figures the owner's home is scored against (#5805): what landed in the
 * last 24 hours and what is live, the builders and the spend against the
 * forge ceiling, why builders sit idle, and what waits on the reader. The
 * same sources the home reads, as plain data for `scripts/home-eval.ts`.
 */

import type { App } from "../app.ts";
import { listReposVisibleTo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { readKpis } from "../flow/kpis.ts";
import { waitingOn } from "../web/studio/asks.ts";

/** Why builders are not all busy, in words; null when every slot runs. */
export function idleReason(b: { running: number; slots: number }, s: { todayUsd: number; ceilingUsd: number | null }): string | null {
  if (b.slots > 0 && b.running >= b.slots) return null;
  if (b.slots === 0) return "no slots set";
  if (s.ceilingUsd !== null && s.todayUsd >= s.ceilingUsd) return `daily ceiling of $${s.ceilingUsd} reached`;
  return "no ready work";
}

export function homeTruth(app: App, user: User, now: Date = new Date()) {
  const k = readKpis(app.db, now, { ceilingUsd: forgeCeiling(app.config) });
  const asks = waitingOn(app.db, user, listReposVisibleTo(app.db, user, { limit: 200, withoutArchived: true }));
  const oldest = asks.reduce<string | null>((o, a) => (o === null || Date.parse(a.since) < Date.parse(o) ? a.since : o), null);
  return {
    landed: k.landed,
    live: k.live,
    builders: { ...k.builders, idle: idleReason(k.builders, k.spend) },
    spend: k.spend,
    waiting: { count: asks.length, oldestAt: oldest },
  };
}
