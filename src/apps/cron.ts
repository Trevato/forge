/**
 * Standard five-field cron in an IANA timezone, as pure functions (no
 * dependency: `Intl` knows the zones). `minute hour day-of-month month
 * day-of-week`, each `*`, a number, `a-b`, `*` with a step `/n`, `a-b/n` or a comma list of
 * those; day-of-week 0 or 7 is Sunday. As in Vixie cron, when both day fields
 * are restricted a day matches if either does.
 *
 * Daylight saving (the rule the issue states): a local time the clock skips
 * (02:30 on the spring-forward night) runs once, at the first instant after
 * the gap; a local time the clock repeats (01:30 on the fall-back night) runs
 * once, at its first occurrence. Times are ms since the epoch (UTC).
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Whether the day-of-month and day-of-week fields were restricted (not `*`). */
  readonly dayRestricted: boolean;
  readonly weekdayRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const NUMBER = /^\d{1,2}$/;

function field(text: string, min: number, max: number, name: string): Result<Set<number>, string> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", step, extra] = part.split("/");
    if (extra !== undefined || (step !== undefined && !/^[1-9]\d{0,2}$/.test(step))) return err(`cron ${name}: "${part.slice(0, 20)}" is not a valid step`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = name === "day of week" ? 6 : max;
    } else {
      const [a = "", b, more] = range.split("-");
      if (more !== undefined || !NUMBER.test(a) || (b !== undefined && !NUMBER.test(b))) return err(`cron ${name}: "${part.slice(0, 20)}" is not a number or range`);
      lo = Number(a);
      hi = b === undefined ? (step === undefined ? lo : max) : Number(b);
    }
    if (lo < min || hi > max || lo > hi) return err(`cron ${name}: "${part.slice(0, 20)}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step === undefined ? 1 : Number(step)) out.add(name === "day of week" && v === 7 ? 0 : v);
  }
  return ok(out);
}

/** Parse a five-field expression, or say which field is wrong. */
export function parseCron(expression: string): Result<CronSpec, string> {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || expression.length > 100) return err("cron needs five fields: minute hour day-of-month month day-of-week");
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i]!;
    const r = field(parts[i]!, f.min, f.max, f.name);
    if (!r.ok) return r;
    sets.push(r.value);
  }
  return ok({
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays: sets[4]!,
    dayRestricted: !parts[2]!.startsWith("*"),
    weekdayRestricted: !parts[4]!.startsWith("*"),
  });
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Whether `Intl` knows the zone. */
export function isTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    zone(tz);
    return true;
  } catch {
    return false;
  }
}

function zone(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall { readonly y: number; readonly mo: number; readonly d: number; readonly h: number; readonly mi: number; readonly s: number }

function wallAt(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of zone(tz).formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p["year"]!, mo: p["month"]!, d: p["day"]!, h: p["hour"]!, mi: p["minute"]!, s: p["second"]! };
}

/** The zone's offset from UTC at an instant, ms (Chicago in summer: -5 h). */
export function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

const DAY = 86_400_000;

/** The instant a local wall time happens: the first if the clock repeats it, the first instant after the gap if it skips it. */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(guess - DAY, tz);
  const after = offsetAt(guess + DAY, tz);
  const found = [before, after].map((o) => guess - o).filter((t) => offsetAt(t, tz) === guess - t);
  if (found.length > 0) return Math.min(...found);
  return guess - before;
}

function dayMatches(spec: CronSpec, y: number, mo: number, d: number): boolean {
  if (!spec.months.has(mo)) return false;
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const byDay = spec.days.has(d);
  const byWeekday = spec.weekdays.has(weekday);
  if (spec.dayRestricted && spec.weekdayRestricted) return byDay || byWeekday;
  return byDay && byWeekday;
}

/** The first instant strictly after `after` the expression fires in `tz`, or undefined when none within five years (31 February). */
export function nextRun(spec: CronSpec, tz: string, after: number): number | undefined {
  const start = wallAt(after, tz);
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  for (let n = 0; n < 366 * 5; n++, day += DAY) {
    const date = new Date(day);
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dayMatches(spec, y, mo, d)) continue;
    let best: number | undefined;
    for (const h of hours)
      for (const mi of minutes) {
        const t = localToUtc(y, mo, d, h, mi, tz);
        if (t > after && (best === undefined || t < best)) best = t;
      }
    if (best !== undefined) return best;
  }
  return undefined;
}
