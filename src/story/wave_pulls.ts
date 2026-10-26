/**
 * The pulls a wave carries, with their live titles: the references come from
 * the wave file (`waves.ts`), the titles from one query. A pull in a
 * repository the viewer cannot read, or one that does not exist, is left out.
 */

import type { Database } from "bun:sqlite";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { PullRef } from "./waves.ts";

/** A page, not an archive. */
const MAX_PULLS = 200;

export interface CarriedPull {
  owner: string;
  name: string;
  number: number;
  title: string;
  mergedAt: string | null;
  state: "open" | "closed";
}

interface Row {
  repo_id: string;
  number: number;
  title: string;
  merged_at: string | null;
  state: "open" | "closed";
}

export function carriedPulls(
  db: Database,
  refs: PullRef[],
  viewer: User | undefined,
): CarriedPull[] {
  const repos = new Map<string, Repo | null>();
  const visible: { ref: PullRef; repo: Repo }[] = [];
  for (const ref of refs.slice(0, MAX_PULLS)) {
    const key = `${ref.owner}/${ref.name}`;
    let repo = repos.get(key);
    if (repo === undefined) {
      const found = getRepo(db, ref.owner, ref.name);
      repo = found && canRead(db, found, viewer) ? found : null;
      repos.set(key, repo);
    }
    if (repo) visible.push({ ref, repo });
  }
  if (visible.length === 0) return [];
  const rows = db
    .query<Row, string[]>(
      `SELECT issue.repo_id, issue.number, issue.title, issue.state, pull.merged_at
         FROM issue JOIN pull ON pull.issue_id = issue.id
        WHERE issue.kind = 'pull' AND (${visible
          .map(() => "(issue.repo_id = ? AND issue.number = ?)")
          .join(" OR ")})`,
    )
    .all(...visible.flatMap(({ ref, repo }) => [repo.id, String(ref.number)]));
  const byKey = new Map(rows.map((r) => [`${r.repo_id}#${r.number}`, r]));
  return visible.flatMap(({ ref, repo }) => {
    const r = byKey.get(`${repo.id}#${ref.number}`);
    return r
      ? [{ owner: ref.owner, name: ref.name, number: ref.number, title: r.title, mergedAt: r.merged_at, state: r.state }]
      : [];
  });
}

/** Where the pull lives on this forge: the local path, never the host the wave file was written with. */
export const pullPath = (p: Pick<CarriedPull, "owner" | "name" | "number">): string =>
  `/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/pulls/${p.number}`;
