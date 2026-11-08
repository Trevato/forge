/**
 * The "silent run" flow alarm (#8707): an agent run that is running and has
 * shown nothing — no log line, no plan update — for `SILENT_MS`. One alarm,
 * naming the run silent longest. The run's state is worked out from what it
 * did (`runs/state.ts`), never what it says.
 */

import type { Database } from "bun:sqlite";
import { SILENT_MS } from "../runs/state.ts";
import { lastActivity } from "../runs/activity.ts";

export interface SilentAlarm {
  readonly fired: boolean;
  readonly since?: string;
  readonly repo?: string;
  readonly number?: number;
  /** The silent run, for a page that links it. */
  readonly runId?: string;
  readonly says: string;
}

export function alarmSilent(db: Database, now: Date): SilentAlarm {
  const running = db
    .query<
      { id: string; repo: string; number: number | null; at: string },
      []
    >(`SELECT x.id, o.username || '/' || r.name AS repo, i.number, COALESCE(x.started_at, x.created_at) AS at
         FROM run x JOIN repo r ON r.id = x.repo_id JOIN user o ON o.id = r.owner_id
         LEFT JOIN issue i ON i.id = x.issue_id
        WHERE x.state = 'running' AND x.kind = 'agent'`)
    .all();
  let oldest: { id: string; repo: string; number: number | null; last: number } | undefined;
  for (const run of running) {
    const last = Math.max(Date.parse(run.at), lastActivity(run.id) ?? 0);
    if (now.getTime() - last <= SILENT_MS) continue;
    if (oldest === undefined || last < oldest.last) oldest = { ...run, last };
  }
  if (oldest === undefined) return { fired: false, says: "No running agent is silent." };
  const minutes = Math.floor((now.getTime() - oldest.last) / 60_000);
  const about = oldest.number === null ? oldest.repo : `${oldest.repo}#${oldest.number}`;
  return {
    fired: true,
    since: new Date(oldest.last).toISOString(),
    repo: oldest.repo,
    ...(oldest.number === null ? {} : { number: oldest.number }),
    runId: oldest.id,
    says: `The run on ${about} has shown nothing for ${minutes} minutes: no log line, no plan update.`,
  };
}
