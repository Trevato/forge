import type { Database } from "bun:sqlite";
import { listReposVisibleTo, type Repo } from "./repos.ts";
import type { User } from "./users.ts";
import { editDistance } from "../text/edit_distance.ts";

const NEAR_MAX = 2;
const NEAR_SHOWN = 3;
const NEAR_SCAN = 500;

/** Up to three repositories the viewer may read whose `owner/name` is within
 * edit distance 2 of what was typed. Visibility is filtered by the listing
 * before any ranking; only the first 500 visible are compared. Asked only
 * when an address already missed: never on a page that was found. */
export function nearRepos(db: Database, viewer: User | undefined, owner: string, name: string): Repo[] {
  if (!owner || !name) return [];
  const asked = `${owner}/${name.replace(/\.git$/, "")}`.toLowerCase().slice(0, 200);
  const found: { repo: Repo; d: number }[] = [];
  let cursor: string | undefined;
  for (let seen = 0; seen < NEAR_SCAN; ) {
    const batch = listReposVisibleTo(db, viewer, {
      limit: Math.min(200, NEAR_SCAN - seen),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const repo of batch) {
      const d = editDistance(asked, `${repo.ownerName}/${repo.name}`.toLowerCase(), NEAR_MAX);
      if (d <= NEAR_MAX) found.push({ repo, d });
    }
    seen += batch.length;
    if (batch.length < 200) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return found
    .sort((x, y) => x.d - y.d)
    .slice(0, NEAR_SHOWN)
    .map((f) => f.repo);
}
