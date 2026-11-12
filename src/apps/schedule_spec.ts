/**
 * `schedules` (top level of `forge.json`): what the forge calls on a clock.
 *
 *     "schedules": [{ "name": "print", "cron": "30 6 * * *", "timezone": "America/Chicago", "path": "/jobs/print" }]
 *
 * Optional per entry: `env` ("production", the default, or "preview"),
 * `timeout` (seconds, default 300, at most 3600), `retries` (0-10, default 3)
 * and `catchUp` ("none", or a window like "30m", "1h", "2d"; default "1h":
 * how late after the forge was away a due run may still fire). Pure: plain
 * data in, plain data or one sentence naming the field out. Unknown keys are
 * refused so a misspelt `timezne` fails the manifest instead of meaning UTC.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { isTimezone, parseCron } from "./cron.ts";

export interface ScheduleSpec {
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  readonly path: string;
  readonly env: "production" | "preview";
  readonly timeoutMs: number;
  readonly retries: number;
  /** ms a missed run may still fire late; 0 is "none". */
  readonly catchUpMs: number;
}

export const SCHEDULES_MAX = 20;
export const TIMEOUT_DEFAULT_S = 300;
export const TIMEOUT_MAX_S = 3600;
export const RETRIES_DEFAULT = 3;
export const RETRIES_MAX = 10;
export const CATCH_UP_DEFAULT_MS = 3_600_000;
export const CATCH_UP_MAX_MS = 7 * 86_400_000;
const KEYS = new Set(["name", "cron", "timezone", "path", "env", "timeout", "retries", "catchUp"]);
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A path the forge may POST to: absolute, no scheme, no control bytes, no dot segments. */
export function isJobPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 200 && /^\/(?!\/)[\x21-\x7e]*$/.test(p) && !p.split("/").some((s) => s === "." || s === "..") && !p.includes("\\");
}

function windowMs(v: unknown): number | undefined {
  if (v === "none") return 0;
  const m = typeof v === "string" ? /^([1-9]\d{0,3})([mhd])$/.exec(v) : null;
  if (m === null) return undefined;
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return ms <= CATCH_UP_MAX_MS ? ms : undefined;
}

export function parseSchedules(value: unknown): Result<readonly ScheduleSpec[], string> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return err("forge.json: schedules must be a list");
  if (value.length > SCHEDULES_MAX) return err(`forge.json: schedules holds at most ${SCHEDULES_MAX}`);
  const out: ScheduleSpec[] = [];
  for (const [i, raw] of value.entries()) {
    const at = `forge.json: schedules[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err(`${at} must be an object`);
    const o = raw as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !KEYS.has(k));
    if (unknown !== undefined) return err(`${at}: unknown key "${unknown.replace(/[^\x20-\x7e]/g, "?").slice(0, 30)}"`);
    if (typeof o["name"] !== "string" || !NAME.test(o["name"])) return err(`${at}.name must be 1-40 lowercase letters, digits, - or _`);
    if (out.some((s) => s.name === o["name"])) return err(`${at}.name "${o["name"]}" is used twice`);
    if (typeof o["cron"] !== "string") return err(`${at}.cron must be a five-field cron string`);
    const cron = parseCron(o["cron"]);
    if (!cron.ok) return err(`${at}.${cron.error}`);
    const timezone = o["timezone"] ?? "UTC";
    if (typeof timezone !== "string" || !isTimezone(timezone)) return err(`${at}.timezone must be an IANA name like America/Chicago`);
    if (!isJobPath(o["path"])) return err(`${at}.path must be an absolute path such as /jobs/print`);
    const env = o["env"] ?? "production";
    if (env !== "production" && env !== "preview") return err(`${at}.env must be "production" or "preview"`);
    const timeout = o["timeout"] ?? TIMEOUT_DEFAULT_S;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT_MAX_S) return err(`${at}.timeout must be whole seconds, 1-${TIMEOUT_MAX_S}`);
    const retries = o["retries"] ?? RETRIES_DEFAULT;
    if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > RETRIES_MAX) return err(`${at}.retries must be 0-${RETRIES_MAX}`);
    const catchUp = o["catchUp"] === undefined ? CATCH_UP_DEFAULT_MS : windowMs(o["catchUp"]);
    if (catchUp === undefined) return err(`${at}.catchUp must be "none" or a window like "30m", "1h", "2d" (at most 7d)`);
    out.push({ name: o["name"], cron: o["cron"].trim().replace(/\s+/g, " "), timezone, path: o["path"], env, timeoutMs: timeout * 1000, retries, catchUpMs: catchUp });
  }
  return ok(out);
}
