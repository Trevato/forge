/**
 * The outsider count (#5930): open, unmerged pulls whose author is neither a
 * writer of the repository nor one of its crew agents. An outsider's pull
 * waits for a person, so it is counted, with the age of the oldest.
 *
 * The author rule is the API's `untrusted` one (`speaksForCrew`), and an
 * imported pull is an outsider's whoever connected it (`voiceOf`).
 * `publicOnly` is `readVitals`'s: public repositories alone.
 */

import type { Database } from "bun:sqlite";
import { getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { speaksForCrew } from "../crew/direct.ts";

const HOUR_MS = 3_600_000;

export interface Outsiders {
  readonly open: number;
  /** Whole hours the oldest outsider pull has waited; 0 when there is none. */
  readonly oldestHours: number;
}

interface Row {
  readonly repo_id: string;
  readonly author_id: string;
  readonly origin_author: string | null;
  readonly created_at: string;
}

export function readOutsiders(db: Database, now = new Date(), publicOnly = false): Outsiders {
  const rows = db
    .query<Row, [number]>(
      `SELECT i.repo_id, i.author_id, i.origin_author, i.created_at
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE (?1 = 0 OR r.visibility = 'public') AND i.state = 'open' AND p.merged_at IS NULL`,
    )
    .all(publicOnly ? 1 : 0);
  const repos = new Map<string, Repo | undefined>();
  const authors = new Map<string, User | undefined>();
  const author = (userId: string) => {
    if (!authors.has(userId)) authors.set(userId, getUserById(db, userId));
    return authors.get(userId);
  };
  let open = 0;
  let oldest = Infinity;
  for (const row of rows) {
    if (!repos.has(row.repo_id)) repos.set(row.repo_id, getRepoById(db, row.repo_id));
    const repo = repos.get(row.repo_id);
    if (repo === undefined) continue;
    const imported = row.origin_author !== null && row.origin_author !== "";
    if (!imported && speaksForCrew(db, repo, author(row.author_id))) continue;
    open++;
    const at = Date.parse(row.created_at);
    if (at < oldest) oldest = at;
  }
  return {
    open,
    oldestHours: open === 0 ? 0 : Math.max(0, Math.floor((now.getTime() - oldest) / HOUR_MS)),
  };
}
