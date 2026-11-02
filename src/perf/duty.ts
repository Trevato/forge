/**
 * The `performance-watcher` duty (#7559): once a minute, judge the record and
 * file each new finding, of a route or of a git subcommand (#8158), as one
 * issue in the forge's own repository, opened by its owner. A title already
 * open is not filed twice, and neither is a key this process has filed.
 */

import type { App } from "../app.ts";
import { openIssue } from "../actions/issues.ts";
import { getUserById } from "../core/users.ts";
import { getRepo } from "../core/repos.ts";
import { listIssues } from "../core/issues.ts";
import { createGitRecord } from "./git.ts";
import type { PerfRecord } from "./record.ts";
import { evaluate, evaluateGit, fresh } from "./watch.ts";

export const TICK_MS = 60_000;

export function startPerfWatcher(
  app: App,
  record: PerfRecord,
  now: () => number = Date.now,
  everyMs = TICK_MS,
  gitRecord: PerfRecord = createGitRecord(),
): () => void {
  const filed = new Set<string>();
  const tick = (): void => {
    try {
      const slug = app.config.forgeRepo;
      if (slug === undefined) return;
      const [owner, name] = slug.split("/") as [string, string];
      const repo = getRepo(app.db, owner, name);
      const actor = repo && getUserById(app.db, repo.ownerId);
      if (!repo || !actor) return;
      const open = new Set(listIssues(app.db, repo.id, { state: "open" }).map((i) => i.title));
      const findings = [...evaluate(record, now()), ...evaluateGit(gitRecord, now())];
      for (const f of fresh(findings, filed)) {
        if (open.has(f.title)) continue;
        openIssue(app, actor, repo, { title: f.title, body: f.evidence });
      }
    } catch (error) {
      app.log.warn("performance watcher failed", { error: String(error) });
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
