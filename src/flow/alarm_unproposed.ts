/**
 * The "unproposed work" alarm (#5930): a branch in a crew member's fork has
 * a head that is not on the fork's default branch, heads no open pull, and
 * is 6 h old or more. Branches are read through the helpers the branches
 * page uses; no branch name reaches a shell.
 */

import type { Database } from "bun:sqlite";
import { listAllForks } from "../core/repos.ts";
import { listBranches } from "../git/branches.ts";
import { repoDir } from "../git/repos.ts";
import { commitLog } from "../git/read.ts";

const HOUR_MS = 3_600_000;
export const UNPROPOSED_AFTER_MS = 6 * HOUR_MS;
const SAYS_MAX = 3;

export interface UnproposedBranch {
  readonly repo: string;
  readonly owner: string;
  readonly branch: string;
  readonly oid: string;
  readonly ageMs: number;
}

export interface UnproposedAlarm {
  readonly fires: boolean;
  readonly says: string;
  /** Oldest first. */
  readonly branches: readonly UnproposedBranch[];
}

function age(ms: number): string {
  const h = Math.floor(ms / HOUR_MS);
  return h >= 48 ? `${Math.floor(h / 24)} d` : `${h} h`;
}

export async function alarmUnproposed(
  db: Database,
  reposRoot: string,
  now: Date,
): Promise<UnproposedAlarm> {
  const crew = new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM user WHERE is_agent = 1")
      .all()
      .map((u) => u.id),
  );
  const proposed = new Set(
    db
      .query<{ head_repo_id: string | null; head_branch: string; head_oid: string }, []>(
        `SELECT pull.head_repo_id, pull.head_branch, pull.head_oid
           FROM pull JOIN issue ON issue.id = pull.issue_id
          WHERE issue.state = 'open' AND pull.merged_at IS NULL`,
      )
      .all()
      .flatMap((p) => [`${p.head_repo_id}\0${p.head_branch}`, `oid\0${p.head_oid}`]),
  );
  const found: UnproposedBranch[] = [];
  for (const fork of listAllForks(db)) {
    if (!crew.has(fork.ownerId) || fork.archivedAt !== null) continue;
    const dir = repoDir(reposRoot, fork.ownerName, fork.name);
    const listing = await listBranches(dir, fork.defaultBranch);
    if (!listing.ok) continue;
    for (const b of listing.value.branches) {
      if (b.isDefault || b.ahead === 0) continue;
      if (proposed.has(`${fork.id}\0${b.name}`) || proposed.has(`oid\0${b.oid}`)) continue;
      const log = await commitLog(dir, b.oid, { limit: 1 });
      const date = log.ok ? log.value[0]?.date : undefined;
      const ageMs = date === undefined ? NaN : now.getTime() - Date.parse(date);
      if (!(ageMs >= UNPROPOSED_AFTER_MS)) continue;
      found.push({
        repo: `${fork.ownerName}/${fork.name}`,
        owner: fork.ownerName,
        branch: b.name,
        oid: b.oid,
        ageMs,
      });
    }
  }
  found.sort((a, b) => b.ageMs - a.ageMs);
  if (found.length === 0) return { fires: false, says: "", branches: [] };
  const oldest = found
    .slice(0, SAYS_MAX)
    .map((b) => `${b.owner}'s ${b.branch} (${age(b.ageMs)})`)
    .join(", ");
  const more = found.length > SAYS_MAX ? ` and ${found.length - SAYS_MAX} more` : "";
  return {
    fires: true,
    says: `Unproposed work: ${found.length} crew ${found.length === 1 ? "branch has" : "branches have"} sat 6 h or more with no open pull: ${oldest}${more}.`,
    branches: found,
  };
}
