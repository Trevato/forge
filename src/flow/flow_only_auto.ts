/**
 * FLOW ONLY lets go by itself (#6395): once the switch is on and no flow alarm
 * has fired for 24 h, the minute's tick turns it off and says so on the feed,
 * once. The last alarm's time lives in `flow_only_watch`; a switch found on
 * with no record starts its 24 h then. Plain data and a clock in, one bool out.
 */
import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../core/repos.ts";

export const FLOW_ONLY_CLEAR_MS = 24 * 3_600_000;

/** The words on the feed when the forge lets go. */
export const FLOW_ONLY_OFF_NOTE = "No flow alarm for 24 h: Flow only is off again.";

/** Steps the watch for `repo`; true when it turned the switch off this call. */
export function stepFlowOnly(
  db: Database,
  bus: Pick<EventBus, "append">,
  repo: Repo,
  alarming: boolean,
  now: number,
): boolean {
  const fresh = getRepoById(db, repo.id);
  if (!fresh?.flowOnly) {
    db.query("DELETE FROM flow_only_watch WHERE repo_id = ?1").run(repo.id);
    return false;
  }
  const row = db.query<{ alarm_at: number }, [string]>("SELECT alarm_at FROM flow_only_watch WHERE repo_id = ?1").get(repo.id);
  if (alarming || !row) {
    db.query(
      `INSERT INTO flow_only_watch (repo_id, alarm_at) VALUES (?1, ?2)
       ON CONFLICT (repo_id) DO UPDATE SET alarm_at = ?2`,
    ).run(repo.id, now);
    return false;
  }
  if (now - row.alarm_at < FLOW_ONLY_CLEAR_MS) return false;
  updateRepoSettings(db, fresh, { flowOnly: false });
  db.query("DELETE FROM flow_only_watch WHERE repo_id = ?1").run(repo.id);
  bus.append({ kind: "flow_only.cleared", repoId: repo.id, payload: { note: FLOW_ONLY_OFF_NOTE } });
  return true;
}
