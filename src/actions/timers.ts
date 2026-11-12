/**
 * An app arms and cancels its own timers (#11595): `POST /api/v1/timers`
 * with `{ at | in, path, key?, body? }` and `DELETE /api/v1/timers/<key>`,
 * under the token its own process holds (`app_token`), never a name it sends.
 * The timer lands in its own environment (production, or the preview that
 * holds the token), is fired by the same loop as a schedule, and is gone
 * after its run. Limits: `FORGE_TIMERS_PER_APP` pending (default 100), a body
 * up to 64 KB, a date within a year.
 */

import type { App } from "../app.ts";
import { isJobPath } from "../apps/schedule_spec.ts";
import { sha256 } from "../kernel/hash.ts";
import { appOfToken } from "../core/device_grants.ts";
import { armTimer, cancelTimer, ONCE_BODY_MAX, ONCE_KEY, pendingOnce, type Arm } from "../core/timers.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type TimerError = "unauthorized" | "invalid" | "too_many" | "not_found";

export const TIMER_WORDS: Record<Exclude<TimerError, "invalid">, string> = {
  unauthorized: "Only an app's own token arms timers.",
  too_many: "This app holds as many pending timers as it may. Cancel one or wait for one to fire.",
  not_found: "No pending timer has that key.",
};

const YEAR_MS = 365 * 86_400_000;
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const timersPerApp = (): number => {
  const n = Number(process.env["FORGE_TIMERS_PER_APP"]);
  return Number.isInteger(n) && n > 0 ? n : 100;
};

/** `in`: whole seconds, or `90s`, `10m`, `2h`, `3d`. */
function delayMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v * 1000;
  const m = typeof v === "string" ? /^(\d{1,9})([smhd])$/.exec(v) : null;
  return m === null ? undefined : Number(m[1]) * UNIT[m[2] as keyof typeof UNIT];
}

/** The app and environment a token secret belongs to: `app:<slug>/<env>` is the name the forge gave it. */
function callerOf(app: App, secret: string): { id: string; slug: string; env: string } | undefined {
  const caller = appOfToken(app.db, secret);
  if (caller === undefined) return undefined;
  const name = app.db.query<{ name: string }, [string]>("SELECT t.name FROM token t JOIN app_token x ON x.token_id = t.id WHERE t.token_hash = ?1").get(sha256(secret))?.name;
  const env = name?.slice(name.indexOf("/") + 1) ?? "";
  return /^(production|pull-\d{1,9})$/.test(env) ? { ...caller, env } : undefined;
}

export interface ArmedTimer { readonly key: string; readonly at: string; readonly path: string; readonly env: string }

export function armFor(app: App, secret: string, input: unknown, now = Date.now()): Result<ArmedTimer, { kind: TimerError; message: string }> {
  const caller = callerOf(app, secret);
  if (caller === undefined) return err({ kind: "unauthorized", message: TIMER_WORDS.unauthorized });
  const bad = (message: string) => err({ kind: "invalid" as const, message });
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("The body is a JSON object.");
  const o = input as Record<string, unknown>;
  const unknown = Object.keys(o).find((k) => !["at", "in", "path", "key", "body"].includes(k));
  if (unknown !== undefined) return bad("Unknown field. The fields are at or in, path, key and body.");
  if ((o["at"] === undefined) === (o["in"] === undefined)) return bad("Give exactly one of `at` (a date) or `in` (seconds, or 10m, 2h, 3d).");
  let when: number;
  if (o["in"] !== undefined) {
    const d = delayMs(o["in"]);
    if (d === undefined) return bad("`in` is whole seconds or a number with s, m, h or d.");
    when = now + d;
  } else {
    when = typeof o["at"] === "number" ? o["at"] : typeof o["at"] === "string" && /^\d{4}-\d\d-\d\dT/.test(o["at"]) ? Date.parse(o["at"]) : Number.NaN;
    if (!Number.isFinite(when)) return bad("`at` is an ISO date such as 2026-12-01T09:00:00Z.");
  }
  if (when > now + YEAR_MS) return bad("A timer may be at most a year away.");
  if (!isJobPath(o["path"])) return bad("`path` is an absolute path on the app, such as /jobs/digest.");
  const key = o["key"] === undefined ? `t-${crypto.randomUUID().slice(0, 12)}` : o["key"];
  if (typeof key !== "string" || !ONCE_KEY.test(key)) return bad("`key` is 1-100 letters, digits, . _ : or -.");
  let body: Uint8Array | undefined;
  if (o["body"] !== undefined) {
    body = new TextEncoder().encode(typeof o["body"] === "string" ? o["body"] : JSON.stringify(o["body"]));
    if (body.length > ONCE_BODY_MAX) return bad("`body` is at most 64 KB.");
  }
  const replacing = app.db.query("SELECT 1 FROM timer WHERE app_id = ?1 AND env = ?2 AND kind = 'once' AND name = '' AND key = ?3").get(caller.id, caller.env, key) !== null;
  if (!replacing && pendingOnce(app.db, caller.id) >= timersPerApp()) return err({ kind: "too_many", message: TIMER_WORDS.too_many });
  const arm: Arm = { appId: caller.id, env: caller.env, key, path: o["path"], at: when, body, timeoutMs: 300_000, retries: 3 };
  armTimer(app.db, arm, now);
  return ok({ key, at: new Date(when).toISOString(), path: o["path"], env: caller.env });
}

export function cancelFor(app: App, secret: string, key: string): Result<true, { kind: TimerError; message: string }> {
  const caller = callerOf(app, secret);
  if (caller === undefined) return err({ kind: "unauthorized", message: TIMER_WORDS.unauthorized });
  return cancelTimer(app.db, caller.id, caller.env, key) ? ok(true) : err({ kind: "not_found", message: TIMER_WORDS.not_found });
}
