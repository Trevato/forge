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
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { smallShareWords } from "../crew/autonomy.ts";
import { admits, heldCounts, heldNow, mapHolds, type Held, type HoldName } from "../crew/held.ts";

export interface HeldRow {
  /** `owner/name`. */
  readonly repo: string;
  readonly public: boolean;
  readonly startable: number;
  readonly counts: Readonly<Record<HoldName, number>>;
  /** Issues a hot file holds, with the open pulls on that file, oldest first. */
  readonly hot: readonly { readonly number: number; readonly detail: string; readonly pulls: readonly number[] }[];
  /** `1/2`: small issues in flight of the builder slots they may hold (#7571). */
  readonly small: string;
}

/** The most hot-file holds a row lists. */
const HOT_ROWS = 5;

/** How long the rows are kept. */
export const HELD_TTL_MS = 5_000;

const kept = new WeakMap<App, { at: number; repos: readonly { repo: Repo; held: Held }[] }>();

/**
 * Each autonomous repository's ready list, sorted by what holds it; private ones for the owner only.
 * The counts are the same for every reader. The pulls a hot file holds are resolved per reader on
 * every call, from memory: a sealed pull is named, and counted, for the owner only.
 */
export function readHeld(app: App, owner: boolean, now = Date.now()): HeldRow[] {
  let entry = kept.get(app);
  if (entry === undefined || now - entry.at >= HELD_TTL_MS || now < entry.at) {
    entry = { at: now, repos: listAutonomousRepos(app.db).map((repo) => ({ repo, held: heldNow(app, repo) })) };
    kept.set(app, entry);
  }
  return entry.repos
    .filter(({ repo }) => owner || repo.visibility === "public")
    .map(({ repo, held }) => {
      const { holds } = mapHolds(repo, held, admits(app, repo, owner ? { sealed: true } : {}));
      return {
        repo: `${repo.ownerName}/${repo.name}`,
        public: repo.visibility === "public",
        startable: held.startable.length,
        counts: heldCounts(held),
        small: smallShareWords(app, repo),
        hot: [...holds].flatMap(([number, h]) =>
          h.by === "hot_file" && h.pulls !== undefined && h.pulls.length > 0
            ? [{ number, detail: h.detail, pulls: h.pulls }]
            : [],
        ).slice(0, HOT_ROWS),
      };
    });
}
