/**
 * An app's fork chain as plain rows, in the words of its forks page: the
 * repo itself, the upstream chain above it (nearest first, ending at the
 * highest ancestor the caller may read) and its direct forks. Each row says
 * how it follows its own parent (`followModeWords`, the Following card's
 * line) and where it stands against it (`driftWords`, the page's meta line).
 * A fork the caller cannot read is not a row and not counted.
 */

import type { App } from "../app.ts";
import { canRead, listAncestors, visibleForks, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { followModeOf } from "./follow.ts";
import { FOLLOWS_NOTHING, followModeWords } from "./follow_words.ts";
import { driftOfForks, driftWords, MAX_RANKED_FORKS } from "./forks.ts";

/** Ancestors listed above the repo; a chain longer than this is cut at the top. */
export const MAX_UPSTREAM = 8;

export interface TreeRow {
  readonly repo: string;
  /** How it follows its parent, in the Following card's line; `follows nothing` at the top of the chain. */
  readonly follows: string;
  /** Commits ahead and behind its parent, as the forks page words them; null at the top. */
  readonly standing: string | null;
  /** When its default branch last moved (ISO), as the page's "pushed"; null when unknown. */
  readonly updatedAt: string | null;
}

export interface TreeRows {
  readonly app: TreeRow;
  readonly upstream: TreeRow[];
  readonly forks: TreeRow[];
  /** More forks exist than the rows hold. */
  readonly truncated: boolean;
}

const nameOf = (r: Repo): string => `${r.ownerName}/${r.name}`;

async function rowOf(app: App, repo: Repo, parent: Repo | undefined): Promise<TreeRow> {
  if (parent === undefined) return { repo: nameOf(repo), follows: FOLLOWS_NOTHING, standing: null, updatedAt: null };
  const [ranked] = await driftOfForks(app, parent, [repo]);
  return {
    repo: nameOf(repo),
    follows: followModeWords(await followModeOf(app, repo), nameOf(parent)).line,
    standing: ranked === undefined ? null : driftWords(ranked.drift),
    updatedAt: ranked?.pushedAt ?? null,
  };
}

/** The rows around `repo`; the caller has already shown they may read it. */
export async function forkTreeRows(app: App, repo: Repo, user: User | undefined): Promise<TreeRows> {
  const chain: Repo[] = [];
  for (const up of listAncestors(app.db, repo.id, MAX_UPSTREAM)) {
    if (!canRead(app.db, up, user)) break;
    chain.push(up);
  }
  const all = visibleForks(app.db, repo.id, user);
  const shown = all.slice(0, MAX_RANKED_FORKS);
  const [self, upstream, forks] = await Promise.all([
    rowOf(app, repo, chain[0]),
    Promise.all(chain.map((r, i) => rowOf(app, r, chain[i + 1]))),
    Promise.all(shown.map((f) => rowOf(app, f, repo))),
  ]);
  return { app: self, upstream, forks, truncated: all.length > shown.length };
}
