/**
 * A polish issue is capped small (#8852): a builder run on an issue labelled
 * `polish` that has gone past `polish.capMinutes` of run time is stopped, not
 * extended, and the issue gets one comment with what is left in a line, as a
 * bet past its appetite does (#8713). Time is the run's own: `startedAt` to
 * now, so a fake clock decides it.
 */

import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { announceRun } from "../actions/runs.ts";
import { polishCapMinutes } from "../core/capacity.ts";
import { getIssueById, labelsForIssues } from "../core/issues.ts";
import { openPullFromHead } from "../core/pulls.ts";
import { cancelRun, listActive } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import type { Repo } from "../core/repos.ts";
import { abortAgentRun } from "./running.ts";

/** Whether a run begun at `startedAt` has used `capMinutes` of run time by `now`. */
export function pastCap(startedAt: string | null, capMinutes: number, now: Date): boolean {
  if (startedAt === null) return false;
  const from = Date.parse(startedAt);
  return Number.isFinite(from) && now.getTime() - from >= capMinutes * 60_000;
}

/** What the run left: its open pull, or plainly that nothing landed. */
export function leftOf(pullNumber: number | undefined): string {
  return pullNumber === undefined ? "nothing landed, no pull open" : `pull #${pullNumber} is open, unmerged`;
}

/** The one line a stopped polish run leaves: the cap, and what is left. */
export function leftLine(capMinutes: number, left: string): string {
  return `Stopped at the ${capMinutes}-minute polish cap, not extended. Left: ${left}.`;
}

/** Stops this repository's polish runs past the cap; answers how many. */
export function tickPolish(app: App, repo: Repo, now = new Date()): number {
  const runs = listActive(app.db, "agent").filter(
    (r) => r.repoId === repo.id && r.state === "running" && r.issueId !== null,
  );
  if (runs.length === 0) return 0;
  const cap = polishCapMinutes(app.db);
  const late = runs.filter((r) => pastCap(r.startedAt, cap, now));
  if (late.length === 0) return 0;
  const labels = labelsForIssues(app.db, late.map((r) => r.issueId!));
  // The comment is the stop's one line, so it is never silent: the autonomy
  // author says it, else the user the run acted as.
  const speaker = (actorId: string | null) => {
    const id = repo.autonomyBy ?? actorId;
    return id === null ? undefined : getUserById(app.db, id);
  };
  let stopped = 0;
  for (const run of late) {
    if (!(labels.get(run.issueId!) ?? []).some((l) => l.name.toLowerCase() === "polish")) continue;
    const by = speaker(run.actorId);
    const issue = getIssueById(app.db, run.issueId!);
    if (by === undefined || issue === undefined) continue; // no one to say it: leave the run, never stop it silently
    const gone = cancelRun(app.db, run.id, `stopped at the ${cap}-minute polish cap`);
    if (gone === undefined) continue;
    abortAgentRun(run.id);
    announceRun(app, gone);
    stopped++;
    const pull = run.branch === "" ? undefined : openPullFromHead(app.db, repo.id, repo.id, run.branch);
    addComment(app, by, repo, issue, leftLine(cap, leftOf(pull?.number)));
  }
  return stopped;
}
