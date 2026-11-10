/**
 * The wave that last moved each milestone: read the newest waves, ask each
 * which milestones its pulls moved (`wave_moved.ts`), and keep, per milestone,
 * the first (newest) wave to name it. Bounded: only the newest few waves are
 * read, so a milestone that moved long ago has no wave rather than a slow page.
 */

import type { Database } from "bun:sqlite";
import type { Plan } from "../core/milestones.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { movedForViewer } from "./wave_moved.ts";
import { ViewCache } from "../view/cache.ts";
import { repoHeads } from "../web/map_cache.ts";
import { pullRefs, readWaves, wavePath, type WaveEntry } from "./waves.ts";

/** How many of the newest waves are read for this. */
export const WAVES_READ = 8;

export interface LastWave {
  version: string;
  date: string;
  headline: string;
  /** Where the wave's page is on this forge. */
  href: string;
}

/**
 * The parsed wave files, kept per repository and its latest event: a push to
 * the branch is an event, so a new wave reads fresh; the TTL covers the rest.
 * Nothing about a viewer is in here, only what the files say.
 */
const waveFiles = new ViewCache({ maxEntries: 64 });
const WAVES_TTL_MS = 60_000;

/** Milestone number to the newest wave that moved it. */
export async function lastWaves(input: {
  db: Database;
  reposRoot: string;
  repo: Repo;
  viewer: User | undefined;
  plan: () => Plan;
}): Promise<Map<number, LastWave>> {
  const { repo } = input;
  // Defence in depth: the routes gate the repository, and so does this.
  if (!canRead(input.db, repo, input.viewer)) return new Map();
  const key = `${repo.id}:${repoHeads(input.db, [repo.id]).get(repo.id) ?? 0}:${repo.defaultBranch}`;
  let entries = waveFiles.get<WaveEntry[]>(key);
  if (entries === undefined) {
    entries = (
      await readWaves(
        repoDir(input.reposRoot, repo.ownerName, repo.name),
        repo.defaultBranch,
      )
    ).slice(0, WAVES_READ);
    waveFiles.set(key, entries, WAVES_TTL_MS);
  }
  const out = new Map<number, LastWave>();
  let plan: Plan | undefined;
  for (const e of entries) {
    if (!e.ok) continue;
    const moved = movedForViewer({
      db: input.db,
      repo,
      refs: pullRefs(e.wave),
      viewer: input.viewer,
      plan: () => (plan ??= input.plan()),
    });
    for (const m of moved)
      if (!out.has(m.number))
        out.set(m.number, {
          version: e.wave.version,
          date: e.wave.date,
          headline: e.wave.headline,
          href: wavePath(repo.ownerName, repo.name, e.wave.version),
        });
  }
  return out;
}
