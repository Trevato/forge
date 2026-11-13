/**
 * The sentinel's half of the main-ahead alarm (#11507): main green and ahead
 * of production past the setting is one finding, and its issue closes itself
 * at the next hunt after production catches up — unless a person spoke on it,
 * then it is theirs to close. When the release tick was never heard from,
 * nothing is filed: the flow alarm asks the owner, naming the keeper's state.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, setIssueState } from "../actions/issues.ts";
import { getIssueById } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { mainAheadAlarm } from "../flow/alarm_main_ahead.ts";
import { createLog } from "../kernel/log.ts";
import { personSpoke } from "./person_spoke.ts";
import type { Finding } from "./sentinel.ts";

const log = createLog("sentinel");

export const MAIN_AHEAD_KEY = "main-ahead";

export function mainAhead(db: Database, now: number): Finding[] {
  const a = mainAheadAlarm(db, new Date(now));
  // A tick never heard from is the deployment's, not the code's (#11924): no builder can
  // fix it, so no issue; the `main_ahead` flow alarm is the owner's ask on home and
  // through the notifier, and says why.
  if (!a.fired || a.neverHeard === true) return [];
  return [{
    key: MAIN_AHEAD_KEY,
    title: "Main is green and ahead of production: the release tick has not cut",
    evidence: a.facts ?? [a.says],
    pillar: "P0 Trust: the forge says when it is not well, and is well again",
    kind: "defect",
    lookFor: "Production runs main's head, or main has been ahead of it for under the limit.",
    urgent: true,
  }];
}

/** Close the open main-ahead issue once its finding is gone; `active` is this hunt's finding keys. */
export function closeCaughtUp(
  app: App,
  repo: Repo,
  actor: User,
  active: ReadonlySet<string>,
  now: number,
  key: string = MAIN_AHEAD_KEY,
  cleared: string = "Production caught up with main",
): void {
  if (active.has(key)) return;
  // Unfiled because the tick was never heard from is not caught up (#11924): an issue
  // opened before stays open while main is still ahead.
  if (key === MAIN_AHEAD_KEY && mainAheadAlarm(app.db, new Date(now)).fired) return;
  const open = app.db
    .query<{ issue_id: string }, [string]>(
      `SELECT t.issue_id FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open' AND t.key = ?1`,
    )
    .all(key);
  for (const t of open) {
    try {
      if (personSpoke(app.db, t.issue_id)) continue;
      const issue = getIssueById(app.db, t.issue_id);
      if (issue === undefined || issue.repoId !== repo.id) continue;
      const said = addComment(app, actor, repo, issue, `${cleared} at ${new Date(now).toISOString()}. Closing as done; if it falls behind again it is filed again.`);
      if (!said.ok) continue;
      setIssueState(app, actor, repo, issue, "closed", { reason: "done", system: true });
    } catch (error) {
      log.error("sentinel close failed", { key, error: String(error) });
    }
  }
}
