/**
 * The sentinel's half of the lane-stopped alarm (#11507): nothing merging for
 * the limit, or one cause failing many pulls, is one finding; its issue closes
 * at the next hunt after the lane moves, unless a person spoke on it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { laneAlarm } from "../flow/alarm_lane.ts";
import { closeCaughtUp } from "./sentinel_main_ahead.ts";
import type { Finding } from "./sentinel.ts";

export const LANE_KEY = "lane-stopped";

export function laneStopped(db: Database, now: number, ceilingUsd: number | null): Finding[] {
  const a = laneAlarm(db, new Date(now), { ceilingUsd });
  if (!a.fired) return [];
  return [{
    key: LANE_KEY,
    title: a.forge === true ? "One failure is stopping many pulls: the forge's, not theirs" : "The lane has stopped: nothing has merged and nothing said so",
    evidence: a.facts ?? [a.says],
    pillar: "P0 Trust: the forge says when it is not well, and is well again",
    kind: "defect",
    lookFor: "A pull merged since, and no one failure line failing five pulls within an hour.",
    urgent: true,
  }];
}

/** Close the open lane issue once the lane moves; `active` is this hunt's finding keys. */
export function closeLaneMoving(app: App, repo: Repo, actor: User, active: ReadonlySet<string>, now: number): void {
  closeCaughtUp(app, repo, actor, active, now, LANE_KEY, "The lane moved: a pull merged and no one failure is stopping many");
}
