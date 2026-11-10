/**
 * The repositories offered as app templates. A site admin marks or unmarks
 * one (a row in `app_template`); `trevato/app-template` is marked by default
 * and always comes first, the rest follow in the order they were marked.
 * `offeredTemplates` lists only those the caller can read, so a private
 * template is never named to someone who cannot see it.
 */

import type { Database } from "bun:sqlite";
import { canRead, getRepo, getRepoById, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** The template every forge offers first, marked without a row. */
export const DEFAULT_TEMPLATE = "trevato/app-template";

/** Marked templates in offer order: the default (when it exists), then by when marked. */
export function markedTemplates(db: Database): Repo[] {
  const rows = db
    .query<{ repo_id: string }, []>("SELECT repo_id FROM app_template ORDER BY marked_at, repo_id")
    .all();
  const out: Repo[] = [];
  const seen = new Set<string>();
  const [owner = "", name = ""] = DEFAULT_TEMPLATE.split("/");
  const first = getRepo(db, owner, name);
  if (first) {
    out.push(first);
    seen.add(first.id);
  }
  for (const r of rows) {
    if (seen.has(r.repo_id)) continue;
    const repo = getRepoById(db, r.repo_id);
    if (repo) {
      out.push(repo);
      seen.add(repo.id);
    }
  }
  return out;
}

/** The marked templates `actor` can read, as `owner/name`, default first. */
export function offeredTemplates(db: Database, actor: User | undefined): string[] {
  return markedTemplates(db)
    .filter((r) => canRead(db, r, actor))
    .map((r) => `${r.ownerName}/${r.name}`);
}

/** Mark (`true`) or unmark (`false`) a repository. Refusing the default's unmarking is the action's job. */
export function setTemplateMark(db: Database, repo: Repo, marked: boolean, actorId: string): void {
  if (marked) {
    db.query("INSERT OR IGNORE INTO app_template (repo_id, marked_by) VALUES (?1, ?2)").run(repo.id, actorId);
  } else {
    db.query("DELETE FROM app_template WHERE repo_id = ?1").run(repo.id);
  }
}
