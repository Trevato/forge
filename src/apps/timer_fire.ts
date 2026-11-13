/**
 * Firing timers (#11595): wake the app, send one signed `POST`, read the
 * answer, and either finish, retry with backoff or fail. Everything that
 * touches the world comes in through `Reach`, so a test drives it with a fake
 * clock and a fake app; the real one is `runtimeReach`.
 *
 * - 2xx is done. Anything else, a timeout, or an app that would not wake is a
 *   failed attempt; attempts run at `BACKOFF_MS` apart up to the timer's
 *   `retries`, then the run is failed and recorded once.
 * - The headers name the schedule, the scheduled instant, the attempt and an
 *   idempotency key (`<app>:<name>:<scheduled time>`); `x-forge-signature`
 *   signs them with the app's own identity key (the scheme of
 *   `proxy.ts`'s `identityHeaders`), so the app can tell its forge sent it.
 * - A timer due while the forge was away fires as soon as it is back when it
 *   is within the schedule's `catchUp` window, recorded as late; beyond it,
 *   the run is recorded as missed and skipped. Timers are rows read at boot,
 *   so a release never drops one.
 * - Five days running of failure pauses a schedule and says so.
 */

import { createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getAppById, type AppRecord } from "../core/apps.ts";
import {
  dueTimers, finishTimer, recordRun, retryTimer, runsOf, setPaused, RESPONSE_KEPT, type Timer, type TimerRun,
} from "../core/timers.ts";
import { nextRun, parseCron } from "./cron.ts";

/** What the forge does to the outside for a timer. */
export interface Reach {
  /** The port the app answers on, waking it if it sleeps; undefined when it will not run. */
  ensure(app: AppRecord, env: Timer["env"]): Promise<number | undefined>;
  /** The key the app verifies the forge with. */
  identityKey(appId: string): string;
  fetch: typeof fetch;
}

export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
/** A run this far behind its scheduled instant is called late. */
export const LATE_AFTER_MS = 30_000;
export const PAUSE_AFTER_DAYS = 5;

export const backoffFor = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;

const iso = (ms: number): string => new Date(ms).toISOString();

/** `<app>:<name>:<scheduled time>`; an app's own one-shot is `<app>:<key>`. */
export function idempotencyKey(slug: string, t: Pick<Timer, "name" | "key" | "scheduledAt" | "kind">): string {
  return t.kind === "once" && t.name === "" ? `${slug}:${t.key}` : `${slug}:${t.name}:${iso(t.scheduledAt)}`;
}

/** The headers of one delivery. The signature covers `forge-timer|<idempotency key>|timer|<expiry ms>`. */
export function deliveryHeaders(key: string, t: Timer, attempt: number, expires: number, idemKey: string): Record<string, string> {
  const identity = `forge-timer|${idemKey}|timer|${expires}`;
  return {
    "x-forge-schedule": t.name === "" ? t.key : t.name,
    "x-forge-scheduled-at": iso(t.scheduledAt),
    "x-forge-attempt": String(attempt),
    "idempotency-key": idemKey,
    "x-forge-identity": identity,
    "x-forge-signature": createHmac("sha256", key).update(identity).digest("base64url"),
    ...(t.body === null ? {} : { "content-type": "application/octet-stream" }),
  };
}

/** The `error` an app's JSON answer names, when it names one. */
function failureText(head: string): string | undefined {
  try {
    const e = (JSON.parse(head) as { error?: unknown }).error;
    return typeof e === "string" && e !== "" ? e : undefined;
  } catch {
    return undefined;
  }
}

/** The headers of a request the forge makes of an app outside a timer (listing or steering its jobs): the same signature, an idempotency key of its own. */
export function controlHeaders(key: string, now: number): Record<string, string> {
  const idem = `control:${crypto.randomUUID()}`;
  const identity = `forge-timer|${idem}|timer|${now + 60_000}`;
  return { "idempotency-key": idem, "x-forge-identity": identity, "x-forge-signature": createHmac("sha256", key).update(identity).digest("base64url") };
}

async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < RESPONSE_KEPT) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || value === undefined) break;
    chunks.push(value);
    n += value.length;
  }
  void reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, RESPONSE_KEPT).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "?");
}

interface Attempt { readonly final?: boolean; readonly ok: boolean; readonly status: number | null; readonly response: string | null; readonly error: string | null }

async function attemptOnce(reach: Reach, app: AppRecord, t: Timer, attempt: number, now: () => number): Promise<Attempt> {
  const port = await reach.ensure(app, t.env).catch(() => undefined);
  if (port === undefined) return { ok: false, status: null, response: null, error: "the app would not wake" };
  const idem = idempotencyKey(app.slug, t);
  try {
    const res = await reach.fetch(`http://127.0.0.1:${port}${t.path}`, {
      method: "POST",
      headers: deliveryHeaders(reach.identityKey(app.id), t, attempt, now() + t.timeoutMs, idem),
      ...(t.body === null ? {} : { body: t.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    const head = await readHead(res);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, response: head, error: null };
    // An app that says `x-forge-no-retry` has decided: delivering again would only repeat it (a durable job that failed, #11596).
    if (res.headers.get("x-forge-no-retry") === "1") return { ok: false, final: true, status: res.status, response: head, error: failureText(head) ?? `the app answered ${res.status}` };
    return { ok: false, status: res.status, response: head, error: `the app answered ${res.status}` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, status: null, response: null, error: timedOut ? `no answer within ${Math.round(t.timeoutMs / 1000)} s` : "the app did not answer" };
  }
}

const inFlight = new Set<number>();

/** The next occurrence of a schedule after `after`, if it has a clock. */
function nextOf(t: Timer, after: number): number | undefined {
  if (t.cron === null || t.timezone === null) return undefined;
  const c = parseCron(t.cron);
  return c.ok ? nextRun(c.value, t.timezone, after) : undefined;
}

/** Whether the schedule has failed on each of the last five days with no success between (the newest runs first). */
export function failingDays(runs: readonly TimerRun[]): number {
  const days = new Set<string>();
  for (const r of runs) {
    if (r.status === "ok") break;
    if (r.status === "failed" || r.status === "missed") days.add(iso(r.scheduledAt).slice(0, 10));
    if (r.status === "paused") break;
  }
  return days.size;
}

/** Fire one due timer: one attempt now, then finish, retry later or fail. */
export async function fireTimer(db: Database, reach: Reach, t: Timer, now: () => number): Promise<void> {
  if (inFlight.has(t.id)) return;
  inFlight.add(t.id);
  try {
    const app = getAppById(db, t.appId);
    if (app === undefined) return void db.query("DELETE FROM timer WHERE id = ?1").run(t.id);
    const started = now();
    const lateMs = Math.max(0, started - t.scheduledAt);
    const idem = idempotencyKey(app.slug, t);
    const base = { appId: t.appId, env: t.env, name: t.name === "" ? t.key : t.name, idemKey: idem, scheduledAt: t.scheduledAt };
    // A schedule that was away past its window skips the runs it missed (one record), and keeps the ones inside it.
    if (t.kind === "schedule" && t.attempt === 0 && lateMs > Math.max(t.catchUpMs, LATE_AFTER_MS)) {
      const window = t.catchUpMs === 0 ? "its catch-up is none" : `it is past its ${Math.round(t.catchUpMs / 60_000)} min catch-up window`;
      recordRun(db, {
        ...base, startedAt: started, finishedAt: started, attempts: 0, status: "missed", httpStatus: null, response: null, durationMs: 0,
        error: `Missed ${iso(t.scheduledAt)}: the forge was not running then, and ${window}, so this run was skipped.`,
        lateMs, lateReason: "the forge was down or restarting at the scheduled time",
      });
      finishTimer(db, t, nextOf(t, Math.max(t.scheduledAt, started - t.catchUpMs - 1)));
      return;
    }
    const attempt = t.attempt + 1;
    const result = await attemptOnce(reach, app, t, attempt, now);
    const finished = now();
    const late = lateMs > LATE_AFTER_MS && t.attempt === 0 ? { lateMs, lateReason: "the forge was down or restarting at the scheduled time; it ran as soon as it was back" } : { lateMs: t.attempt === 0 ? 0 : lateMs, lateReason: t.attempt === 0 ? null : "retried after a failed attempt" };
    const next = t.kind === "schedule" ? nextOf(t, t.scheduledAt) : undefined;
    if (result.ok) {
      recordRun(db, { ...base, startedAt: started, finishedAt: finished, attempts: attempt, status: "ok", httpStatus: result.status, response: result.response, error: null, ...late, durationMs: finished - started });
      finishTimer(db, t, next);
      return;
    }
    if (result.final !== true && attempt <= t.retries) return retryTimer(db, t.id, finished + backoffFor(t.attempt), attempt);
    recordRun(db, {
      ...base, startedAt: started, finishedAt: finished, attempts: attempt, status: "failed", httpStatus: result.status, response: result.response,
      error: result.final === true ? (result.error ?? "failed") : `${result.error ?? "failed"}, after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}`, ...late, durationMs: finished - started,
    });
    finishTimer(db, t, next);
    if (t.kind === "schedule" && failingDays(runsOf(db, t.appId, t.name, 30).filter((r) => r.env === t.env)) >= PAUSE_AFTER_DAYS) {
      setPaused(db, t.id, true, finished);
      recordRun(db, {
        ...base, startedAt: finished, finishedAt: finished, attempts: 0, status: "paused", httpStatus: null, response: null, durationMs: 0,
        error: `Paused itself: it failed ${PAUSE_AFTER_DAYS} days running. Resume it once the app is fixed.`, lateMs: 0, lateReason: null,
      });
    }
  } finally {
    inFlight.delete(t.id);
  }
}

/** Fire every timer due at `now()`; the count fired. A slow app delays only its own timer. */
export async function fireDueTimers(db: Database, reach: Reach, now: () => number = Date.now): Promise<number> {
  const due = dueTimers(db, now());
  await Promise.all(due.map((t) => fireTimer(db, reach, t, now).catch(() => undefined)));
  return due.length;
}
