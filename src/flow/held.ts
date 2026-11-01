/**
 * Why ready issues cannot start, per autonomous repository (#2244): the
 * rows /flow draws as bars and the terminal's Flow dialog prints as lines —
 * `crew/held.ts`'s counts, the same the autonomy tick logs as `held=`.
 *
 * Sorting a ready list asks a few queries per issue, so the rows are kept
 * for a few seconds: a page reloaded, or the dialog opened beside it, reads
 * them once. The tick never reads this cache; it sorts afresh every time.
 */

import type { App } from "../app.ts";
import { listAutonomousRepos } from "../core/repos.ts";
import { smallShareWords } from "../crew/autonomy.ts";
import { heldCounts, heldNow, type HoldName } from "../crew/held.ts";

export interface HeldRow {
  /** `owner/name`. */
  readonly repo: string;
  readonly public: boolean;
  readonly startable: number;
  readonly counts: Readonly<Record<HoldName, number>>;
  /** `1/2`: small issues in flight of the builder slots they may hold (#7571). */
  readonly small: string;
}

/** How long the rows are kept. */
export const HELD_TTL_MS = 5_000;

const kept = new WeakMap<App, { at: number; rows: readonly HeldRow[] }>();

/** Each autonomous repository's ready list, sorted by what holds it; private ones for the owner only. */
export function readHeld(app: App, owner: boolean, now = Date.now()): HeldRow[] {
  let entry = kept.get(app);
  if (entry === undefined || now - entry.at >= HELD_TTL_MS || now < entry.at) {
    entry = {
      at: now,
      rows: listAutonomousRepos(app.db).map((repo) => {
        const held = heldNow(app, repo);
        return {
          repo: `${repo.ownerName}/${repo.name}`,
          public: repo.visibility === "public",
          startable: held.startable.length,
          counts: heldCounts(held),
          small: smallShareWords(app, repo),
        };
      }),
    };
    kept.set(app, entry);
  }
  return entry.rows.filter((r) => owner || r.public);
}
