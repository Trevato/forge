/**
 * The fired flow alarms (#5930) as lines: one `.small` line each, `says`
 * linked to the item it names, above the feed. Nothing fired draws nothing,
 * so there is no empty box and no layout shift. Owner only: the caller has
 * checked, because the words name private repositories.
 */
import type { Database } from "bun:sqlite";
import { firedAlarms, type FiredAlarm } from "../../flow/alarms.ts";
import { writeStamp } from "../../core/write_clock.ts";
import { Stamped } from "../../kernel/stamped.ts";
import { html, type Html } from "../html.ts";
import { HOME_MAX_AGE_MS } from "./home_cache.ts";

const caches = new WeakMap<Database, Stamped<FiredAlarm[]>>();

/** Valid like the vitals: while the write clock holds, 30 seconds at most. */
export function cachedAlarms(db: Database, now: Date, ceilingUsd: number | null): FiredAlarm[] {
  const stamp = writeStamp(db);
  if (stamp === undefined) return firedAlarms(db, now, { ceilingUsd });
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Stamped<FiredAlarm[]>({ maxEntries: 2, maxAgeMs: HOME_MAX_AGE_MS });
    caches.set(db, cache);
  }
  return cache.get("alarms", stamp, () => firedAlarms(db, now, { ceilingUsd }));
}

export function alarmLines(alarms: readonly FiredAlarm[]): Html {
  if (alarms.length === 0) return html``;
  return html`<div class="stack">
    ${alarms.map((a) => html`<p class="small"><a href="${a.href}">${a.says}</a></p>`)}
  </div>`;
}
