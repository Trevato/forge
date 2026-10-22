/**
 * Mirror out: after a landing, a repository migrated with "keep the source
 * as a read-only mirror" pushes to it (`pushToMirrorTarget`). It listens for
 * the two events that move a branch — a pull landing and a push — and runs
 * one push at a time per repository; a burst coalesces into the push that
 * follows it, because the push sends whatever moved, not whatever was heard.
 */

import type { App } from "../app.ts";
import { getMirrorTarget } from "../core/migrate_mirror.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { pushToMirrorTarget } from "./push-through.ts";

/** Stops listening; the promise settles once pushes already running have ended. */
export function startMirrorOut(
  app: App,
  push: (app: App, repo: Repo) => Promise<unknown> = pushToMirrorTarget,
): () => Promise<void> {
  const running = new Set<string>();
  const ending = new Set<Promise<void>>();
  const again = new Set<string>();

  async function run(repoId: string): Promise<void> {
    if (running.has(repoId)) {
      again.add(repoId);
      return;
    }
    running.add(repoId);
    try {
      do {
        again.delete(repoId);
        const repo = getRepoById(app.db, repoId);
        if (repo) await push(app, repo);
      } while (again.has(repoId));
    } catch (error) {
      app.log.error("mirror push failed", { repoId, error: String(error) });
    } finally {
      running.delete(repoId);
    }
  }

  const unsubscribe = app.bus.subscribe((event) => {
    if (event.repoId === null) return;
    if (event.kind !== "pull.merged" && event.kind !== "push") return;
    // The migration's own arrival event: the target already holds that history.
    if (event.payload["via"] === "migrate") return;
    if (!getMirrorTarget(app.db, event.repoId)) return;
    const p = run(event.repoId).finally(() => ending.delete(p));
    ending.add(p);
  });

  return async () => {
    unsubscribe();
    await Promise.allSettled([...ending]);
  };
}
