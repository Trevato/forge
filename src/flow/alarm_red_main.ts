/**
 * The "red main" flow alarm (#5930): the forge repository's default branch
 * has had a red latest check for {@link RED_MAIN_MIN} minutes or more.
 * Plain data in (the db, `now`), plain data out; nothing draws it here.
 */

import type { Database } from "bun:sqlite";
import { redMain } from "../checks/red_main.ts";
import { getRepo } from "../core/repos.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";

/** How long main may stay red before the alarm fires. */
export const RED_MAIN_MIN = 10;

export interface RedMainAlarm {
  readonly fired: boolean;
  /** When the current red streak began, while main is red. */
  readonly since?: string;
  readonly says: string;
}

/** The first failure after main's last green check: when the streak began. */
function streakStart(db: Database, repoId: string, fallback: string): string {
  const row = db
    .query<{ at: string | null }, [string]>(
      `SELECT MIN(COALESCE(r.finished_at, r.created_at)) AS at
         FROM run r JOIN repo ON repo.id = r.repo_id
        WHERE r.repo_id = ?1 AND r.kind = 'check' AND r.issue_id IS NULL
          AND r.env = repo.default_branch AND r.state = 'failed'
          AND r.id > COALESCE((
            SELECT MAX(g.id) FROM run g
             WHERE g.repo_id = r.repo_id AND g.kind = 'check' AND g.issue_id IS NULL
               AND g.env = repo.default_branch AND g.state = 'ok'), '')`,
    )
    .get(repoId);
  return row?.at ?? fallback;
}

export function redMainAlarm(db: Database, now: Date): RedMainAlarm {
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  const red = repo ? redMain(db, repo.id) : undefined;
  if (!repo || !red) return { fired: false, says: "Main is green." };
  const since = streakStart(db, repo.id, red.since);
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
  if (!(minutes >= RED_MAIN_MIN)) {
    return { fired: false, since, says: `Main went red ${Math.max(minutes, 0)} min ago.` };
  }
  const what = red.failing[0] ?? red.summary.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    fired: true,
    since,
    says: `Main has been red for ${minutes} min${what ? `: ${what}` : ""}.`,
  };
}
