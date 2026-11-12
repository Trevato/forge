/**
 * An app's schedules, seen and steered (#11595): one row each with its next
 * run, its last run and how it went, and the two things a writer may do,
 * **Run now** and **Pause**. The page, `GET …/schedules`, the MCP tool and the
 * owner's ask all read these functions, so they say the same words. Times are
 * ms since the epoch; `when` words them in the schedule's own timezone.
 */

import type { App } from "../app.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canAdmin, listReposWritableTo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { failedJobs, failingNow, runNow, runsOf, scheduleTimer, scheduleTimers, setPaused, type TimerRun } from "../core/timers.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireReader, requireWriter } from "./access.ts";

export interface LastRun {
  readonly at: number;
  readonly status: TimerRun["status"];
  readonly attempts: number;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly late: string | null;
  readonly error: string | null;
  /** The first 2 KB of what the app answered. */
  readonly response: string | null;
}

export interface ScheduleRow {
  readonly name: string;
  readonly env: string;
  readonly cron: string;
  readonly timezone: string;
  readonly path: string;
  readonly paused: boolean;
  readonly nextAt: number | null;
  readonly last: LastRun | null;
  /** The whole row in words, for the tool and the terminal. */
  readonly line: string;
}

/** `Fri 13 Nov 06:30 CST` in the zone. */
export function when(ms: number, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(ms))
    p[part.type] = part.value;
  return `${p["weekday"]} ${p["day"]} ${p["month"]} ${p["hour"]}:${p["minute"]} ${p["timeZoneName"]}`;
}

/** What the app answered and why a run failed is the app's own output (often a digest or an internal error): a writer reads it, other readers get null. */
const lastOf = (r: TimerRun, writer: boolean): LastRun => ({
  at: r.startedAt, status: r.status, attempts: r.attempts, durationMs: r.durationMs, httpStatus: r.httpStatus,
  late: r.lateMs > 30_000 ? (r.lateReason ?? "ran late") : null, error: writer ? r.error : null, response: writer ? r.response : null,
});

function lineOf(r: Omit<ScheduleRow, "line">): string {
  const last = r.last === null ? "never run" : `last ${r.last.status === "ok" ? "ok" : r.last.status} ${when(r.last.at, r.timezone)}${r.last.status === "ok" ? ` (${r.last.durationMs} ms${r.last.late === null ? "" : ", ran late"})` : ""}`;
  return `${r.name} · ${r.cron} ${r.timezone} · ${r.paused ? "paused" : `next ${r.nextAt === null ? "soon" : when(r.nextAt, r.timezone)}`} · ${last}`;
}

/** Production's schedules of the repository's app, one row each (a preview's are rows only while that preview lives). */
export function scheduleRows(app: App, actor: User | undefined, repo: Repo): Result<ScheduleRow[], "not_found"> {
  if (!requireReader(app, actor, repo).ok) return err("not_found");
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err("not_found");
  const writer = requireWriter(app, actor, repo).ok;
  const runs = runsOf(app.db, record.id, undefined, 200);
  return ok(
    scheduleTimers(app.db, record.id).map((t) => {
      const last = runs.find((r) => r.name === t.name && r.env === t.env);
      const row = {
        name: t.name, env: t.env, cron: t.cron ?? "", timezone: t.timezone ?? "UTC", path: t.path, paused: t.paused,
        nextAt: t.paused ? null : t.dueAt, last: last === undefined ? null : lastOf(last, writer),
      };
      return { ...row, line: lineOf(row) };
    }),
  );
}

/** The newest runs, of one schedule or all, with their attempts and responses. */
export function scheduleRuns(app: App, actor: User | undefined, repo: Repo, name?: string, limit = 30): Result<TimerRun[], "not_found"> {
  if (!requireReader(app, actor, repo).ok) return err("not_found");
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err("not_found");
  const writer = requireWriter(app, actor, repo).ok;
  const runs = runsOf(app.db, record.id, name, Math.min(100, Math.max(1, limit)));
  return ok(writer ? runs : runs.map((r) => ({ ...r, response: null, error: null })));
}

export type SteerError = "not_found" | "unauthorized" | "forbidden";

/** Run a schedule now: the next occurrence is untouched, the firing loop picks it up within a second. */
export function steerSchedule(app: App, actor: User | undefined, repo: Repo, name: string, env: string, action: "run" | "pause" | "resume", now = Date.now()): Result<true, SteerError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return err(writer.error);
  const record = getAppByRepo(app.db, repo.id);
  const t = record === undefined ? undefined : scheduleTimer(app.db, record.id, name, env);
  if (record === undefined || t === undefined) return err("not_found");
  if (action === "run") runNow(app.db, record.id, name, env, now);
  else setPaused(app.db, t.id, action === "pause", now);
  // Every door that steers says so on the bus, so a page open on the app redraws its schedules without a reload.
  app.bus.append({ kind: "schedule.steered", repoId: repo.id, actorId: writer.value.id, payload: { name, env, action } });
  return ok(true);
}

/**
 * What asks an app's owner: one line per schedule whose latest run did not go,
 * with the reason. The item is the schedule, not the run, so a schedule that
 * keeps failing is one ask, not one a day (`crew/notify.ts` says only what is new).
 */
export function scheduleLines(app: App, user: User, now = Date.now()): { line: string; items: string[]; link: string }[] {
  if (user.kind !== "user") return [];
  const out: { line: string; items: string[]; link: string }[] = [];
  for (const repo of listReposWritableTo(app.db, user, { limit: 200, withoutArchived: true })) {
    const record = canAdmin(app.db, repo, user) ? getAppByRepo(app.db, repo.id) : undefined;
    if (record === undefined) continue;
    for (const run of failingNow(app.db, record.id)) {
      const why = run.status === "failed" ? `Schedule ${run.name} failed: ${run.error}` : run.error;
      out.push({ line: `${repo.name}: ${why}`, items: [`schedule:${record.id}:${run.env}:${run.name}`], link: `/${repo.ownerName}/${repo.name}#schedules` });
    }
    // A durable job that failed for good is one ask, named by its run (`job:<run>:<wake>`), never one per wake.
    const seen = new Set<string>();
    for (const run of failedJobs(app.db, record.id, now)) {
      const id = run.name.split(":")[1] ?? run.name;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ line: `${repo.name}: a job run failed: ${run.error ?? "no reason given"}`, items: [`job:${record.id}:${id}`], link: `/${repo.ownerName}/${repo.name}/app/jobs` });
    }
  }
  return out;
}
