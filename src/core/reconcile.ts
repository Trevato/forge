/**
 * Boot reconciliation: make on-disk reality match the index before serving.
 * Today it refreshes every repo's hook stubs — the hook contract can change
 * between releases, and a stale pre-receive fails closed (silently rejecting
 * every push to an older repo), so an upgrade must re-lay them. This is also
 * the seat for future git-is-truth repair (healing index rows from ref state).
 *
 * It runs before the listeners come up, which makes it the one piece of
 * startup a growing forge waits on: two thousand repos done one at a time is
 * four filesystem round trips each, in series, while nothing is being served.
 * So it fans out — bounded, because the point is not to replace a slow boot
 * with a thundering herd of file writes.
 */

import type { App } from "../app.ts";
import { installHooks } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import { repoExists } from "../git/repos.ts";

/** Repos reconciled at once. Filesystem work, so wider than the git limit. */
const CONCURRENCY = 32;

export async function reconcile(app: App): Promise<void> {
  const rows = app.db
    .query<{ owner_name: string; name: string }, []>(
      `SELECT user.username AS owner_name, repo.name AS name
       FROM repo JOIN user ON user.id = repo.owner_id`,
    )
    .all();

  let refreshed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const row = rows[index];
      if (row === undefined) return;
      const dir = repoDir(app.reposRoot, row.owner_name, row.name);
      // HEAD, not the directory: hooks can only be installed into a usable
      // repository, and a half-removed one (no HEAD) is not that.
      if (await repoExists(dir)) {
        await installHooks(dir);
        refreshed++;
      } else {
        app.log.warn("repo row without a git directory", {
          repo: `${row.owner_name}/${row.name}`,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker),
  );

  app.log.info("reconciled", {
    repos: rows.length,
    hooks_refreshed: refreshed,
  });
}
