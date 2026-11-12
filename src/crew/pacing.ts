/**
 * How fast the crew may go, given what each subscription has left. A pure
 * policy: the accounts' standing in (`core/standing.ts`), the operator's
 * slot ceiling and what a run costs on average, and out come the slots to
 * use now and, when there are none, the instant to look again.
 *
 * Slots rise toward the window capacity the crew may still spend — the
 * remaining dollars, less the share the operator keeps for people — and fall
 * to nothing at a wall, never past the operator's ceiling. An account
 * whose cap is not yet known (the provider has not refused it once) is
 * not a limit: it counts for the ceiling, so a new account is never throttled
 * on a guess.
 */

import type { LimitWindow, Standing } from "../core/standing.ts";
import { whenText } from "./limits.ts";

export interface Account {
  readonly name: string;
  readonly standing: Standing;
}

export interface Pace {
  /** Runs that may be in flight at once, 0..ceiling. */
  readonly slots: number;
  /** When to look again if no run may start; null while one may. */
  readonly nextAt: string | null;
  /** Why the pace is below the ceiling, in a sentence; "" at full pace. */
  readonly reason: string;
}

const LABEL: Readonly<Record<LimitWindow, string>> = {
  "5h": "5-hour",
  week: "weekly",
};

/** The slots and next dispatch time for `accounts` at `now`. */
export function pace(
  accounts: readonly Account[],
  ceiling: number,
  runUsd: number,
  now: Date,
): Pace {
  if (accounts.length === 0 || ceiling <= 0)
    return { slots: Math.max(ceiling, 0), nextAt: null, reason: "" };
  const t = now.getTime();
  const unit = runUsd > 0 ? runUsd : 1;
  let total = 0;
  let walls: { at: number; text: string }[] = [];
  for (const { name, standing } of accounts) {
    let room = Infinity;
    let wall: { at: number; text: string } | undefined;
    for (const w of standing.windows) {
      if (w.crewRemaining === null) continue;
      const left = w.crewRemaining.value;
      if (left > 0) {
        room = Math.min(room, left);
        continue;
      }
      const at = w.resetsAt === null ? undefined : Date.parse(w.resetsAt.value);
      // A window past its reset has opened again; its figure is stale.
      if (at !== undefined && at <= t) continue;
      room = 0;
      // The account is back when its last full window resets.
      if (at !== undefined && (wall === undefined || at > wall.at))
        wall = {
          at,
          text: `${name}'s ${LABEL[w.window]} window is full until ${whenText(new Date(at))}`,
        };
    }
    if (room === 0) {
      if (wall !== undefined) walls.push(wall);
      continue;
    }
    // A window with some room left is at least one run's worth.
    total += room === Infinity ? ceiling : Math.max(1, Math.floor(room / unit));
  }
  const slots = Math.min(ceiling, total);
  if (slots > 0)
    return {
      slots,
      nextAt: null,
      reason:
        slots < ceiling
          ? `${slots} of ${ceiling} slots: the subscriptions' windows are filling`
          : "",
    };
  walls = walls.sort((a, b) => a.at - b.at);
  const first = walls[0];
  return {
    slots: 0,
    nextAt: first === undefined ? null : new Date(first.at).toISOString(),
    reason: first?.text ?? "the subscriptions' windows are spent",
  };
}

/**
 * What a paused run's card says: which account, which window, when it
 * resets — or the provider's own words when it named no window.
 */
export function pauseReason(
  name: string | undefined,
  limit: { window: LimitWindow; resetsAt: Date } | undefined,
  said: string,
): string {
  if (limit === undefined) return said;
  const who = name === undefined ? "the" : `${name}'s`;
  return `${who} ${LABEL[limit.window]} window is full until ${whenText(limit.resetsAt)}`;
}

/**
 * What a paused run's summary says caused the pause, in a word for the log:
 * the provider's balance ("credit"), a full window or limit ("rate limit"),
 * the network, or an account resting. Read from the summary the run wrote.
 */
export function pauseCause(summary: string): string {
  const said = summary.replace(/^paused: /, "").toLowerCase();
  if (/\b(credit|balance|billing|budget|quota)\b/.test(said)) return "credit";
  if (/\bnetwork\b/.test(said)) return "network";
  if (/\b(window|limit|rate|overloaded|resting)\b/.test(said)) return "rate limit";
  return "other";
}

/**
 * `07:21 UTC` when `at` falls on `now`'s UTC day, `2026-11-14 07:21 UTC`
 * when it does not: a weekly window that lifts in days must not read like
 * a time later today.
 */
export function resumeText(at: Date, now: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  return day === now.toISOString().slice(0, 10) ? whenText(at) : `${day} ${whenText(at)}`;
}

/**
 * A paused run's note, the same words on the web card and the terminal's
 * run row: when its limit lifts, or "soon" when the stored time is unreadable.
 */
export function pausedNote(notBefore: string, now: Date = new Date()): string {
  const at = new Date(notBefore);
  return Number.isNaN(at.getTime())
    ? "paused, resumes soon"
    : `paused, resumes ${resumeText(at, now)}`;
}
