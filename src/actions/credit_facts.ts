/**
 * A repository's credit as the REST and MCP answers carry it (#10904): the
 * same reading the page and the terminal print, as plain data. Null for a
 * repository that is not a mirror.
 */

import type { App } from "../app.ts";
import { creditOf, type Credit } from "../core/credit.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { localSource } from "../view/local.ts";

export async function creditFacts(app: App, repo: Repo, viewer: User | undefined): Promise<Credit | null> {
  const credit = await creditOf(app.db, app.reposRoot, repo, viewer, localSource(app, repo, viewer), repo.defaultBranch);
  return credit ?? null;
}
