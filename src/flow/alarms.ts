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
import { alarmBackup } from "./alarm_backup.ts";
import { alarmFromApp } from "./alarm_from_app.ts";
import { alarmPaidOrder } from "./alarm_paid_order.ts";
import { alarmIdleCrew } from "./alarm_idle_crew.ts";
import { laneAlarm } from "./alarm_lane.ts";
import { mainAheadAlarm } from "./alarm_main_ahead.ts";
import { noReleaseAlarm } from "./alarm_no_release.ts";
import { redMainAlarm } from "./alarm_red_main.ts";
import { alarmRepeat } from "./alarm_repeat.ts";
import { alarmSilent } from "./alarm_silent.ts";
import { alarmStuck } from "./alarm_stuck.ts";

export interface FiredAlarm {
  readonly key: "landing_stopped" | "red_main" | "stuck" | "idle_crew" | "no_release" | "main_ahead" | "lane_stopped" | "bug_clock" | "silent" | "repeat" | "from_app" | "unreachable" | "backup" | "paid_order";
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
  /** `dataDir` is required so a caller cannot forget it and lose the backup alarm; `null` says there is none to read (a unit over a bare db). */
  opts: { readonly dataDir: string | null; readonly publicOnly?: boolean; readonly ceilingUsd?: number | null },
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
    const fromApp = alarmFromApp(db, now);
    if (fromApp.fired) out.push({ key: "from_app", says: fromApp.says, since: fromApp.since!, href: `/${fromApp.repo}/issues/${fromApp.number}` });
    const backup = opts.dataDir === null ? undefined : alarmBackup(opts.dataDir, now);
    if (backup?.fired) out.push({ key: "backup", says: backup.says, since: backup.since!, href: "/flow" });
    const paidOrder = alarmPaidOrder(db);
    if (paidOrder.fired) out.push({ key: "paid_order", says: paidOrder.says, since: paidOrder.since!, href: "/settings/billing" });
    const idle = alarmIdleCrew(db, now, { ceilingUsd: opts.ceilingUsd ?? null });
    if (idle.fired) out.push({ key: "idle_crew", says: idle.says, since: idle.since!, href: "/boards" });
  }
  const release = noReleaseAlarm(db, now);
  if (release.fired) out.push({ key: "no_release", says: release.says, since: release.since!, href: "/releases" });
  const ahead = mainAheadAlarm(db, now);
  if (ahead.fired) out.push({ key: "main_ahead", says: ahead.says, since: ahead.since!, href: "/releases" });
  const lane = laneAlarm(db, now, { ceilingUsd: opts.ceilingUsd ?? null });
  if (lane.fired) out.push({ key: "lane_stopped", says: lane.says, since: lane.since!, href: "/flow" });
  const bug = bugClockAlarm(db, now, opts.publicOnly ? { publicOnly: true } : {});
  if (bug.fired) out.push({ key: "bug_clock", says: bug.says, since: bug.since!, href: bug.href });
  return out;
}
