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
import { canAdmin, getRepo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { ownRepoPath } from "../../kernel/own_repo.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
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

/**
 * `offerFor` is the repository path whose FLOW ONLY switch is off and the
 * viewer administers (#6395): one button follows the block, a post to the same
 * switch the setting uses, so it is same-origin, admin-only and undoable there.
 * One for the block, not one per line, so a screen reader hears it once; the
 * post lands on the setting, where it is turned off again, and the title says so.
 */
export function alarmLines(alarms: readonly FiredAlarm[], offerFor?: string): Html {
  if (alarms.length === 0) return html``;
  const offer =
    offerFor === undefined
      ? null
      : html`<form method="post" action="/${offerFor}/settings/flow-only" class="inline" title="Turns Flow only on and opens its setting">
          <input type="hidden" name="flowOnly" value="1" />${btn("Flow only", { size: "sm" })}
        </form>`;
  return html`<div class="stack" role="alert">
    ${alarms.map((a) => html`<p class="small"><a href="${a.href}">${a.says}</a></p>`)}
    ${offer}
  </div>`;
}

/** The own repository's path when its switch is off and `user` administers it; else undefined. */
export function flowOnlyOffer(db: Database, user: User): string | undefined {
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  return repo && !repo.flowOnly && canAdmin(db, repo, user) ? `${repo.ownerName}/${repo.name}` : undefined;
}
