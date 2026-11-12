/**
 * What waits on a crew team (#10162): the open pulls that close an issue
 * naming the team and that the team still holds (`teamsHolding`), oldest
 * first. Rows are cut at `limit` after the viewer's reading rights apply.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "./pulls.ts";
import { teamsHolding } from "./issue_teams.ts";
import { canRead, getRepoById } from "./repos.ts";
import { mayView } from "./sealed.ts";
import type { User } from "./users.ts";

export const QUEUE_MAX = 50;

export interface QueuedPull {
  readonly repoId: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  created_at: string;
  sealed: number;
  author_id: string;
  head_oid: string;
}

/** The SQL of the walk, shared with the plan test. */
export const OPEN_PULLS_OLDEST_FIRST = `SELECT issue.id, issue.repo_id, issue.number, issue.title, issue.body,
        issue.created_at, issue.sealed, issue.author_id, pull.head_oid
   FROM issue JOIN pull ON pull.issue_id = issue.id
  WHERE issue.state = 'open' AND issue.kind = 'pull' AND pull.merged_at IS NULL
  ORDER BY issue.created_at, issue.id`;

/** The issues that name `slug`, as `repoId#number`: the only ones a pull can hold for it. */
export const NAMING_TEAM = `SELECT issue.repo_id, issue.number
   FROM issue_team JOIN issue ON issue.id = issue_team.issue_id
  WHERE issue_team.team_slug = ?1`;

export function pullsWaitingOn(
  db: Database,
  slug: string,
  viewer: User | undefined,
  limit = QUEUE_MAX,
): QueuedPull[] {
  const out: QueuedPull[] = [];
  const naming = new Set(
    db.query<{ repo_id: string; number: number }, [string]>(NAMING_TEAM).all(slug).map((r) => `${r.repo_id}#${r.number}`),
  );
  if (naming.size === 0) return out;
  const rows = db.query<Row, []>(OPEN_PULLS_OLDEST_FIRST).iterate();
  const repos = new Map<string, ReturnType<typeof getRepoById>>();
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!closesFromBody(r.body).some((n) => naming.has(`${r.repo_id}#${n}`))) continue;
    if (!repos.has(r.repo_id)) repos.set(r.repo_id, getRepoById(db, r.repo_id));
    const repo = repos.get(r.repo_id);
    if (!repo || !canRead(db, repo, viewer)) continue;
    if (!mayView(db, repo, { sealed: r.sealed === 1, authorId: r.author_id }, viewer)) continue;
    const holding = teamsHolding(db, { id: r.id, repoId: r.repo_id, body: r.body, headOid: r.head_oid });
    if (!holding.some((v) => v.team === slug)) continue;
    out.push({
      repoId: r.repo_id,
      owner: repo.ownerName,
      repo: repo.name,
      number: r.number,
      title: r.title,
      createdAt: r.created_at,
    });
  }
  return out;
}
