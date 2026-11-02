/**
 * A run the provider turned away — a rate limit, a session's usage window,
 * an overloaded model — has nothing wrong with it. The forge pauses it,
 * clone and session intact, and starts it again when the provider says
 * it will listen; the person who asked never has to press anything.
 */

import type { Database } from "bun:sqlite";
import { noteLimit, type LimitWindow } from "../core/standing.ts";
import { PLATFORM, restSubscription } from "../core/subscriptions.ts";
import { isNetworkError } from "./network.ts";
import type { ClaudeOutcome } from "./claude.ts";

/** How many times one task may be paused before the forge gives up on it. */
export const MAX_PAUSES = 6;

/** When the provider gives no time, try again after this long. */
const DEFAULT_WAIT_MS = 15 * 60_000;
/** A moment past the reset, so the first request lands inside the new window. */
const SLACK_MS = 60_000;

/**
 * Whether an outcome is the provider's refusal rather than the agent's
 * failure. Claude Code ends such a run with `api_error`; the message names
 * the limit, and is checked too in case the ending is named differently.
 */
export function isRateLimited(outcome: ClaudeOutcome): boolean {
  if (outcome.ok || isNetworkError(outcome)) return false;
  return (
    outcome.reason === "api_error" ||
    /rate[ _-]?limit|session limit|usage limit|weekly limit|hit your \w+ limit|overloaded|too many requests|\b(?:429|529)\b/i.test(
      outcome.result,
    )
  );
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * When to try again. Claude Code says `resets 7:20am (UTC)` or
 * `resets 2:20am (America/Chicago)` for a session's window, and
 * `resets Sep 26 at 9pm (America/Chicago)` for the week's; that clock time
 * in that zone, on that date or the next occurrence, plus a minute.
 * Anything else waits the default.
 */
export function resumeAt(message: string, now: Date): Date {
  const at = resetOf(message, now);
  if (at === undefined) return new Date(now.getTime() + DEFAULT_WAIT_MS);
  return new Date(at.getTime() + SLACK_MS);
}

/**
 * Which window the provider said is full, and the instant it resets — read
 * from its own words, or undefined when it named no time. The week is named
 * (`weekly limit`) or dated (`resets Sep 26 at 9pm`); a bare clock time is
 * the 5-hour session window. No slack is added: this is the provider's time.
 */
export function limitOf(
  message: string,
  now: Date,
): { window: LimitWindow; resetsAt: Date } | undefined {
  const match = RESET.exec(message);
  const resetsAt = resetOf(message, now);
  if (match === null || resetsAt === undefined) return undefined;
  const weekly = match[1] !== undefined || /\bweek(?:ly)?\b/i.test(message);
  return { window: weekly ? "week" : "5h", resetsAt };
}

const RESET =
  /resets?\s+(?:at\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/** The reset instant a message names, exactly; undefined when it names none. */
function resetOf(message: string, now: Date): Date | undefined {
  const match = RESET.exec(message);
  if (match === null) return undefined;
  const [, monthName, day, h, m, meridiem, zone] = match;
  const hour = (Number(h) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(m ?? "0");
  const month =
    monthName === undefined
      ? -1
      : MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  const date =
    monthName !== undefined && month >= 0
      ? { month: month + 1, day: Number(day) }
      : undefined;
  return nextWallTime(now, hour, minute, zone!, date);
}

/**
 * The provider's refusal, taken in: the window it names is noted on the
 * account's standing, and a sealed account (`subscriptionId` given) rests
 * until the provider's time. The forge's own token (`undefined`) is noted
 * but never rested — nothing else would take its place. One place for a run
 * and a conversation turn alike.
 */
export function takeLimit(
  db: Database,
  subscriptionId: string | undefined,
  message: string,
  fallback: string,
  now: Date,
): { until: Date; limit: ReturnType<typeof limitOf>; said: string } {
  const said = (message.split("\n").find((l) => l.trim() !== "") ?? fallback).slice(0, 160);
  const until = resumeAt(message, now);
  const limit = limitOf(message, now);
  if (limit !== undefined)
    noteLimit(db, subscriptionId ?? PLATFORM, {
      window: limit.window,
      resetsAt: limit.resetsAt.toISOString(),
      observedAt: now.toISOString(),
      said,
    });
  if (subscriptionId !== undefined) restSubscription(db, subscriptionId, until.toISOString(), said);
  return { until, limit, said };
}

/** `12:04 UTC` — how a resume time reads on a card. */
export function whenText(at: Date): string {
  return `${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * The next instant at which a clock in `zone` reads `hour:minute`, strictly
 * after `now`. The zone's offset is taken from the runtime's own tables,
 * so daylight time is right without a list of rules here.
 */
function nextWallTime(
  now: Date,
  hour: number,
  minute: number,
  zone: string,
  date?: { month: number; day: number },
): Date | undefined {
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return undefined; // not a zone the runtime knows
  }
  const wall = (date: Date): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of parts.formatToParts(date))
      if (p.type !== "literal") out[p.type] = Number(p.value);
    return out;
  };
  // The instant whose wall clock in `zone` is `y-m-d hour:minute`: start
  // from the UTC reading and correct by the zone's offset at that instant.
  const instantOf = (y: number, mo: number, d: number): Date => {
    let guess = new Date(Date.UTC(y, mo - 1, d, hour, minute));
    for (let i = 0; i < 2; i++) {
      const w = wall(guess);
      const asUtc = Date.UTC(
        w["year"]!,
        w["month"]! - 1,
        w["day"]!,
        w["hour"]!,
        w["minute"]!,
        w["second"]!,
      );
      const want = Date.UTC(y, mo - 1, d, hour, minute);
      guess = new Date(guess.getTime() + (want - asUtc));
    }
    return guess;
  };
  const today = wall(now);
  if (date !== undefined) {
    // A named date this year, or next year's if it has already passed.
    const thisYear = instantOf(today["year"]!, date.month, date.day);
    if (thisYear.getTime() > now.getTime()) return thisYear;
    return instantOf(today["year"]! + 1, date.month, date.day);
  }
  const candidate = instantOf(today["year"]!, today["month"]!, today["day"]!);
  if (candidate.getTime() > now.getTime()) return candidate;
  const tomorrow = new Date(candidate.getTime() + 36 * 3_600_000);
  const t = wall(tomorrow);
  return instantOf(t["year"]!, t["month"]!, t["day"]!);
}
