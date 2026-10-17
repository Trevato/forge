/**
 * Archive or wake a repository straight in the database, the way the action
 * does (`moveArchived`), for suites that test what an archived repository
 * refuses rather than how it got there. The repository as it is after.
 */
import type { Database } from "bun:sqlite";
import { getRepoById, moveArchived, type Repo } from "../../src/core/repos.ts";

export function setArchivedIn(db: Database, repo: Repo, archived: boolean): Repo {
  moveArchived(db, repo.id, archived);
  const now = getRepoById(db, repo.id);
  if (now === undefined) throw new Error(`no repository ${repo.id}`);
  return now;
}
