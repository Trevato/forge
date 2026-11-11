/**
 * What shipped since the last check-in (#11464): the release versions cut and
 * the pillars whose merged count rose. Read from what the changelog and the
 * pillar map already read; `compose` words them, nothing here writes prose.
 */

import type { App } from "../app.ts";
import { publicForgeRepo } from "../core/forge_repo.ts";
import { mergedByPillar, pillarsOf, servedBy } from "../core/pillars.ts";
import { readChangelog } from "../release/changelog.ts";
import { repoDir } from "../git/repos.ts";

export interface Story {
  /** Versions cut since the last check-in, oldest first. */
  readonly releases: readonly string[];
  /** Pillars that merged work since then, with how many pulls. */
  readonly pillarsMoved: readonly { readonly pillar: string; readonly merged: number }[];
}

export const NO_STORY: Story = { releases: [], pillarsMoved: [] };

/** Pure: releases newer than `sinceMs`, oldest first. */
export function releasesSince(entries: readonly { version: string; date: string }[], sinceMs: number): string[] {
  return entries
    .filter((e) => Date.parse(e.date) > sinceMs)
    .map((e) => e.version)
    .reverse();
}

/** The story since `sinceMs`; empty when the forge has no public source repository. */
export async function storyFacts(app: App, sinceMs: number): Promise<Story> {
  const repo = publicForgeRepo(app);
  if (repo === undefined) return NO_STORY;
  const entries = await readChangelog(repoDir(app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch);
  const set = pillarsOf(app.db, repo);
  const moved: { pillar: string; merged: number }[] = [];
  if (set.pillars.length > 0) {
    for (const m of mergedByPillar(app.db, repo.id, set, servedBy(app.db, set), new Date(sinceMs).toISOString())) {
      if (m.pillar !== null && m.merged > 0) moved.push({ pillar: m.pillar, merged: m.merged });
    }
    moved.sort((x, y) => y.merged - x.merged);
  }
  return { releases: releasesSince(entries, sinceMs), pillarsMoved: moved };
}
