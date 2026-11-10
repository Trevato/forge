/**
 * The `performance-watcher` duty (#7559): once a minute, judge the record and
 * file each new finding, of a route or of a git subcommand (#8158), as one
 * issue in the forge's own repository, opened by its owner. A title already
 * open is not filed twice, and neither is a key this process has filed. A
 * slow route or subcommand is a defect: filed with its kind's labels, a `bug`
 * on its clock (#8856).
 */

import type { App } from "../app.ts";
import { openIssue } from "../actions/issues.ts";
import { getUserById } from "../core/users.ts";
import { getRepo } from "../core/repos.ts";
import { listIssues } from "../core/issues.ts";
import { addLabels, kindLabels } from "../hunt/label.ts";
import { createGitRecord } from "./git.ts";
import type { PerfRecord } from "./record.ts";
import { evaluate, evaluateGit, fresh } from "./watch.ts";
import { during } from "./jobs.ts";

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
        const made = openIssue(app, actor, repo, { title: f.title, body: f.evidence });
        if (made.ok) addLabels(app, repo.id, actor.id, made.value, kindLabels(app, repo.id, f.kind));
      }
    } catch (error) {
      app.log.warn("performance watcher failed", { error: String(error) });
    }
  };
  const timer = setInterval(() => during("perf-watcher", tick), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
