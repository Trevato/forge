/**
 * Boot reconciliation: make on-disk reality match the index before serving.
 * Today it refreshes every repo's hook stubs — the hook contract can change
 * between releases, and a stale pre-receive fails closed (silently rejecting
 * every push to an older repo), so an upgrade must re-lay them. This is also
 * the seat for future git-is-truth repair (healing index rows from ref state).
 */

import type { App } from "../app.ts";
import { installHooks } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import { repoExists } from "../git/repos.ts";

export async function reconcile(app: App): Promise<void> {
  const rows = app.db
    .query<{ owner_name: string; name: string }, []>(
      `SELECT user.username AS owner_name, repo.name AS name
       FROM repo JOIN user ON user.id = repo.owner_id`,
    )
    .all();

  let refreshed = 0;
  for (const row of rows) {
    const dir = repoDir(app.reposRoot, row.owner_name, row.name);
    if (await repoExists(dir)) {
      await installHooks(dir);
      refreshed++;
    } else {
      app.log.warn("repo row without a git directory", {
        repo: `${row.owner_name}/${row.name}`,
      });
    }
  }
  app.log.info("reconciled", {
    repos: rows.length,
    hooks_refreshed: refreshed,
  });
}
