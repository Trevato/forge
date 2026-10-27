/** The `flow` label's dispatch, apart from flow_only.ts so dispatch.ts can import that without a cycle. */

import type { App } from "../app.ts";
import { getAgent } from "../core/agents.ts";
import { getIssueById, type Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { queueAgentRun } from "./dispatch.ts";
import { flowOnlyHolds, hadAgentRun } from "./flow_only.ts";

/**
 * The `flow` label just reached an issue the switch was holding: start its
 * run, this issue only. The run is paid by whoever last assigned it, not by
 * the one who labelled, so the guest rule holds as it does in the sweep.
 */
export function dispatchFlowLabelled(app: App, repo: Repo, issue: Issue): void {
  const now = getIssueById(app.db, issue.id);
  if (now === undefined || now.state !== "open" || now.assigneeId === null) return;
  if (flowOnlyHolds(app.db, repo, now)) return;
  if (hadAgentRun(app.db, now.id)) return;
  const agent = getAgent(app.db, now.assigneeId);
  if (agent === undefined) return;
  const assigner = app.db
    .query<{ actor_id: string | null }, [string, string, number]>(
      `SELECT actor_id FROM event WHERE repo_id = ?1 AND kind = ?2
         AND json_extract(payload, '$.number') = ?3 ORDER BY id DESC LIMIT 1`,
    )
    .get(repo.id, `${now.kind}.assigned`, now.number);
  queueAgentRun(app, repo, now, agent, "assigned", assigner?.actor_id ?? undefined);
}
