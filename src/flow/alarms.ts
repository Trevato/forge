/**
 * The four flow alarms (#5930) read together: the ones that are firing, each
 * with its words, when it began and the page of the item it names. Home and
 * /boards draw them, the notifier tells the owner once per start, and the
 * MCP `flow` tool carries them. `publicOnly` leaves private repositories out
 * for a reader who must not learn their names. Pure over the db and `now`.
 */

import type { Database } from "bun:sqlite";
import { landingStopped, stoppedSentence } from "../checks/gate_stopped.ts";
import { redHref, redMain } from "../checks/red_main.ts";
import { getRepo } from "../core/repos.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { bugClockAlarm } from "./bugs.ts";
import { alarmIdleCrew } from "./alarm_idle_crew.ts";
import { noReleaseAlarm } from "./alarm_no_release.ts";
import { redMainAlarm } from "./alarm_red_main.ts";
import { alarmRepeat } from "./alarm_repeat.ts";
import { alarmSilent } from "./alarm_silent.ts";
import { alarmStuck } from "./alarm_stuck.ts";

export interface FiredAlarm {
  readonly key: "landing_stopped" | "red_main" | "stuck" | "idle_crew" | "no_release" | "bug_clock" | "silent" | "repeat" | "unreachable";
  readonly says: string;
  readonly since: string;
  /** A same-origin path to the item the alarm names. */
  readonly href: string;
}

function redMainHref(db: Database): string {
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  const red = repo ? redMain(db, repo.id) : undefined;
  return red ? redHref(red) : "/boards";
}

export function firedAlarms(
  db: Database,
  now: Date,
  opts: { readonly publicOnly?: boolean; readonly ceilingUsd?: number | null } = {},
): FiredAlarm[] {
  const out: FiredAlarm[] = [];
  const [owner, name] = ownRepoPath().split("/");
  const own = owner && name ? getRepo(db, owner, name) : undefined;
  const stopped = own && !opts.publicOnly ? landingStopped(db, own.id) : undefined;
  if (stopped) out.push({ key: "landing_stopped", says: stoppedSentence(stopped), since: stopped.since, href: "/boards" });
  const red = redMainAlarm(db, now);
  if (red.fired) out.push({ key: "red_main", says: red.says, since: red.since!, href: redMainHref(db) });
  const stuck = alarmStuck(db, now, opts.publicOnly ? { publicOnly: true } : {});
  if (stuck.fired) {
    out.push({ key: "stuck", says: stuck.says, since: stuck.since!, href: `/${stuck.repo}/pulls/${stuck.number}` });
  }
  if (!opts.publicOnly) {
    const silent = alarmSilent(db, now);
    if (silent.fired) out.push({ key: "silent", says: silent.says, since: silent.since!, href: `/${silent.repo}/runs/${silent.runId}` });
    const repeat = alarmRepeat(db);
    if (repeat.fired) out.push({ key: "repeat", says: repeat.says, since: repeat.since!, href: `/${repeat.repo}/issues/${repeat.number}` });
    const idle = alarmIdleCrew(db, now, { ceilingUsd: opts.ceilingUsd ?? null });
    if (idle.fired) out.push({ key: "idle_crew", says: idle.says, since: idle.since!, href: "/boards" });
  }
  const release = noReleaseAlarm(db, now);
  if (release.fired) out.push({ key: "no_release", says: release.says, since: release.since!, href: "/releases" });
  const bug = bugClockAlarm(db, now, opts.publicOnly ? { publicOnly: true } : {});
  if (bug.fired) out.push({ key: "bug_clock", says: bug.says, since: bug.since!, href: bug.href });
  return out;
}
