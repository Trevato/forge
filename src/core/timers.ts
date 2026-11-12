/**
 * Timers, the one primitive of time (#11595): a row of (app, environment,
 * when, what to call, a key). A schedule is a timer that re-arms after each
 * run; a one-shot is how an app sleeps until later. Plain rows in, plain
 * rows out: firing is `apps/timer_fire.ts`, the clock arithmetic
 * `apps/cron.ts`. Nothing here reads the clock: every function takes `now`.
 */

import type { Database } from "bun:sqlite";
import { nextRun, parseCron } from "../apps/cron.ts";
import type { ScheduleSpec } from "../apps/schedule_spec.ts";

/** "production" or the preview environment it belongs to (`pull-12`). */
export type TimerEnv = string;
export type TimerKind = "schedule" | "once";

export interface Timer {
  readonly id: number;
  readonly appId: string;
  readonly env: TimerEnv;
  readonly kind: TimerKind;
  /** A schedule's name; a manual run of one carries it too; "" for a one-shot an app armed. */
  readonly name: string;
  readonly key: string;
  readonly path: string;
  readonly body: Uint8Array | null;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly catchUpMs: number;
  readonly scheduledAt: number;
  readonly dueAt: number;
  readonly attempt: number;
  readonly paused: boolean;
}

export type RunStatus = "ok" | "failed" | "missed" | "paused";

export interface TimerRun {
  readonly id: number;
  readonly appId: string;
  readonly env: TimerEnv;
  readonly name: string;
  readonly idemKey: string;
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly attempts: number;
  readonly status: RunStatus;
  readonly httpStatus: number | null;
  /** The first 2 KB of the response. */
  readonly response: string | null;
  /** The reason in plain words when it did not go. */
  readonly error: string | null;
  readonly lateMs: number;
  readonly lateReason: string | null;
  readonly durationMs: number;
}

type Row = Record<string, unknown>;
const toTimer = (r: Row): Timer => ({
  id: r["id"] as number,
  appId: r["app_id"] as string,
  env: r["env"] as TimerEnv,
  kind: r["kind"] as TimerKind,
  name: r["name"] as string,
  key: r["key"] as string,
  path: r["path"] as string,
  body: (r["body"] as Uint8Array | null) ?? null,
  cron: (r["cron"] as string | null) ?? null,
  timezone: (r["timezone"] as string | null) ?? null,
  timeoutMs: r["timeout_ms"] as number,
  retries: r["retries"] as number,
  catchUpMs: r["catch_up_ms"] as number,
  scheduledAt: r["scheduled_at"] as number,
  dueAt: r["due_at"] as number,
  attempt: r["attempt"] as number,
  paused: r["paused"] === 1,
});
const toRun = (r: Row): TimerRun => ({
  id: r["id"] as number,
  appId: r["app_id"] as string,
  env: r["env"] as TimerEnv,
  name: r["name"] as string,
  idemKey: r["idem_key"] as string,
  scheduledAt: r["scheduled_at"] as number,
  startedAt: r["started_at"] as number,
  finishedAt: r["finished_at"] as number,
  attempts: r["attempts"] as number,
  status: r["status"] as RunStatus,
  httpStatus: (r["http_status"] as number | null) ?? null,
  response: (r["response"] as string | null) ?? null,
  error: (r["error"] as string | null) ?? null,
  lateMs: r["late_ms"] as number,
  lateReason: (r["late_reason"] as string | null) ?? null,
  durationMs: r["duration_ms"] as number,
});

/** Timers due at `now`, oldest first. Paused ones wait. */
export function dueTimers(db: Database, now: number, limit = 50): Timer[] {
  return db.query<Row, [number, number]>("SELECT * FROM timer WHERE paused = 0 AND due_at <= ?1 ORDER BY due_at, id LIMIT ?2").all(now, limit).map(toTimer);
}

export function getTimer(db: Database, id: number): Timer | undefined {
  const r = db.query<Row, [number]>("SELECT * FROM timer WHERE id = ?1").get(id);
  return r === null ? undefined : toTimer(r);
}

/** The schedule timers of an app, by name (environment included). */
export function scheduleTimers(db: Database, appId: string): Timer[] {
  return db.query<Row, [string]>("SELECT * FROM timer WHERE app_id = ?1 AND kind = 'schedule' ORDER BY name, env").all(appId).map(toTimer);
}

export function scheduleTimer(db: Database, appId: string, name: string, env: TimerEnv): Timer | undefined {
  const r = db.query<Row, [string, string, string]>("SELECT * FROM timer WHERE app_id = ?1 AND kind = 'schedule' AND name = ?2 AND env = ?3").get(appId, name, env);
  return r === null ? undefined : toTimer(r);
}

export function syncedCommit(db: Database, appId: string, env: TimerEnv): string | undefined {
  return db.query<{ commit_oid: string }, [string, string]>("SELECT commit_oid FROM timer_sync WHERE app_id = ?1 AND env = ?2").get(appId, env)?.commit_oid;
}

/**
 * Make the app's schedule rows say what `forge.json` at `commit` declares for
 * this environment: new ones armed for their next occurrence, changed ones
 * kept at their place unless the clock changed, removed ones dropped. A
 * pause survives a redeploy.
 */
export function syncSchedules(db: Database, appId: string, env: TimerEnv, specs: readonly ScheduleSpec[], commit: string, now: number): void {
  const mine = specs.filter((s) => s.env === (env === "production" ? "production" : "preview"));
  db.transaction(() => {
    const names = new Set(mine.map((s) => s.name));
    for (const t of scheduleTimers(db, appId)) if (t.env === env && !names.has(t.name)) db.query("DELETE FROM timer WHERE id = ?1").run(t.id);
    for (const s of mine) {
      const cron = parseCron(s.cron);
      if (!cron.ok) continue;
      const existing = scheduleTimer(db, appId, s.name, env);
      if (existing !== undefined && existing.cron === s.cron && existing.timezone === s.timezone) {
        db.query("UPDATE timer SET path = ?2, timeout_ms = ?3, retries = ?4, catch_up_ms = ?5 WHERE id = ?1").run(existing.id, s.path, s.timeoutMs, s.retries, s.catchUpMs);
        continue;
      }
      const next = nextRun(cron.value, s.timezone, now);
      if (next === undefined) continue;
      if (existing !== undefined) db.query("DELETE FROM timer WHERE id = ?1").run(existing.id);
      db.query(
        `INSERT INTO timer (app_id, env, kind, name, key, path, cron, timezone, timeout_ms, retries, catch_up_ms, scheduled_at, due_at, paused, created_at)
         VALUES (?1, ?2, 'schedule', ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12)`,
      ).run(appId, env, s.name, s.path, s.cron, s.timezone, s.timeoutMs, s.retries, s.catchUpMs, next, existing?.paused ? 1 : 0, now);
    }
    db.query("INSERT OR REPLACE INTO timer_sync (app_id, env, commit_oid) VALUES (?1, ?2, ?3)").run(appId, env, commit);
  })();
}

export const ONCE_BODY_MAX = 64 * 1024;
export const ONCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export interface Arm {
  readonly appId: string;
  readonly env: TimerEnv;
  readonly key: string;
  readonly path: string;
  readonly at: number;
  readonly body?: Uint8Array | undefined;
  /** A manual run of a schedule carries its name; an app's own one-shot has none. */
  readonly name?: string | undefined;
  readonly timeoutMs: number;
  readonly retries: number;
}

/** Arm a one-shot. Arming a key again replaces the pending timer (one per key). */
export function armTimer(db: Database, a: Arm, now: number): void {
  db.query(
    `INSERT INTO timer (app_id, env, kind, name, key, path, body, timeout_ms, retries, catch_up_ms, scheduled_at, due_at, created_at)
     VALUES (?1, ?2, 'once', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
     ON CONFLICT (app_id, env, kind, name, key) DO UPDATE SET path = excluded.path, body = excluded.body, timeout_ms = excluded.timeout_ms,
       retries = excluded.retries, scheduled_at = excluded.scheduled_at, due_at = excluded.due_at, attempt = 0`,
  ).run(a.appId, a.env, a.name ?? "", a.key, a.path, a.body ?? null, a.timeoutMs, a.retries, 365 * 86_400_000, a.at, now);
}

/** Cancel an app's pending one-shot by key; whether there was one. */
export function cancelTimer(db: Database, appId: string, env: TimerEnv, key: string): boolean {
  return db.query("DELETE FROM timer WHERE app_id = ?1 AND env = ?2 AND kind = 'once' AND name = '' AND key = ?3").run(appId, env, key).changes > 0;
}

/** How many one-shots the app holds pending. */
export function pendingOnce(db: Database, appId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM timer WHERE app_id = ?1 AND kind = 'once' AND name = ''").get(appId)?.n ?? 0;
}

export function pendingTimers(db: Database, appId: string, limit = 100): Timer[] {
  return db.query<Row, [string, number]>("SELECT * FROM timer WHERE app_id = ?1 AND kind = 'once' AND name = '' ORDER BY due_at LIMIT ?2").all(appId, limit).map(toTimer);
}

export function setPaused(db: Database, id: number, paused: boolean, now: number): void {
  const t = getTimer(db, id);
  if (t === undefined) return;
  // Resuming never fires a backlog of missed occurrences: it waits for the next one.
  if (!paused && t.cron !== null && t.timezone !== null) {
    const c = parseCron(t.cron);
    const next = c.ok ? nextRun(c.value, t.timezone, now) : undefined;
    if (next !== undefined) {
      db.query("UPDATE timer SET paused = 0, scheduled_at = ?2, due_at = ?2, attempt = 0 WHERE id = ?1").run(id, next);
      return;
    }
  }
  db.query("UPDATE timer SET paused = ?2 WHERE id = ?1").run(id, paused ? 1 : 0);
}

/** A one-shot is done; a schedule re-arms for `next` with a fresh attempt count. */
export function finishTimer(db: Database, t: Timer, next: number | undefined): void {
  if (t.kind === "once" || next === undefined) db.query("DELETE FROM timer WHERE id = ?1").run(t.id);
  else db.query("UPDATE timer SET scheduled_at = ?2, due_at = ?2, attempt = 0 WHERE id = ?1").run(t.id, next);
}

/** Try again at `dueAt`: the occurrence keeps its scheduled time and key. */
export function retryTimer(db: Database, id: number, dueAt: number, attempt: number): void {
  db.query("UPDATE timer SET due_at = ?2, attempt = ?3 WHERE id = ?1").run(id, dueAt, attempt);
}

export const RESPONSE_KEPT = 2048;

export function recordRun(db: Database, r: Omit<TimerRun, "id">): void {
  db.query(
    `INSERT INTO timer_run (app_id, env, name, idem_key, scheduled_at, started_at, finished_at, attempts, status, http_status, response, error, late_ms, late_reason, duration_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  ).run(r.appId, r.env, r.name, r.idemKey, r.scheduledAt, r.startedAt, r.finishedAt, r.attempts, r.status, r.httpStatus, r.response?.slice(0, RESPONSE_KEPT) ?? null, r.error, r.lateMs, r.lateReason, r.durationMs);
  // A history, not a log: the newest 200 runs of an app are kept.
  db.query("DELETE FROM timer_run WHERE app_id = ?1 AND id <= (SELECT id FROM timer_run WHERE app_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET 200)").run(r.appId);
}

/** Runs of the app, newest first; of one schedule when `name` is given. */
export function runsOf(db: Database, appId: string, name?: string, limit = 50): TimerRun[] {
  const rows = name === undefined
    ? db.query<Row, [string, number]>("SELECT * FROM timer_run WHERE app_id = ?1 ORDER BY id DESC LIMIT ?2").all(appId, limit)
    : db.query<Row, [string, string, number]>("SELECT * FROM timer_run WHERE app_id = ?1 AND name = ?2 ORDER BY id DESC LIMIT ?3").all(appId, name, limit);
  return rows.map(toRun);
}

/** The newest run of each of the app's schedules whose latest run did not go (for the owner's ask). One index walk per schedule. */
export function failingNow(db: Database, appId: string): TimerRun[] {
  const out: TimerRun[] = [];
  for (const t of scheduleTimers(db, appId)) {
    const r = db.query<Row, [string, string, string]>("SELECT * FROM timer_run WHERE app_id = ?1 AND name = ?2 AND env = ?3 ORDER BY id DESC LIMIT 1").get(appId, t.name, t.env);
    if (r !== null && r["status"] !== "ok") out.push(toRun(r));
  }
  return out;
}

/** Drop the schedule rows of environments that are gone (a closed pull's preview). */
export function dropGoneEnvs(db: Database, appId: string, live: ReadonlySet<string>): void {
  for (const t of scheduleTimers(db, appId)) if (!live.has(t.env)) db.query("DELETE FROM timer WHERE id = ?1").run(t.id);
  for (const r of db.query<{ env: string }, [string]>("SELECT env FROM timer_sync WHERE app_id = ?1").all(appId))
    if (!live.has(r.env)) db.query("DELETE FROM timer_sync WHERE app_id = ?1 AND env = ?2").run(appId, r.env);
}

/** Run a schedule once now, apart from its clock: its next occurrence is untouched. */
export function runNow(db: Database, appId: string, name: string, env: TimerEnv, now: number): boolean {
  const t = scheduleTimer(db, appId, name, env);
  if (t === undefined) return false;
  armTimer(db, { appId, env, key: `run-${now}`, name, path: t.path, at: now, timeoutMs: t.timeoutMs, retries: t.retries }, now);
  return true;
}
