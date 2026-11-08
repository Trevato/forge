/**
 * Pace (#6848): how many issues a milestone closed each day over the last
 * `PACE_DAYS` UTC days, and the date it is on pace to finish. Pure: it is
 * handed the closing times and the numbers `readPlan` already has for the
 * milestone's estimate, so the sentence under the estimate and this line
 * cannot name different days. `now` is given, never read.
 */

/** Days drawn, today last. */
export const PACE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface Pace {
  /** Issues closed each day, oldest first, today last: `PACE_DAYS` numbers. */
  readonly closedPerDay: readonly number[];
  /** The UTC date (YYYY-MM-DD) it is on pace to finish; null when stalled, done, deferred or empty. */
  readonly paceDate: string | null;
  /** `on pace for <date>`, `no movement in 7 days`, `done <date>`, or "" when there is nothing to say. */
  readonly line: string;
}

/** What the estimate was worked out from. */
export interface PaceInput {
  /** When each issue beneath that counts and is closed, closed. */
  readonly closedAt: readonly string[];
  readonly total: number;
  readonly open: number;
  readonly deferred: boolean;
  /** Closed in the estimate's window. */
  readonly closedInWindow: number;
  /** The window, in days. */
  readonly window: number;
  /** Days to finish at that pace, as the estimate says them. */
  readonly days: number;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function paceOf(input: PaceInput, now: Date): Pace {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const index = new Map(
    Array.from({ length: PACE_DAYS }, (_, i) => [dayOf(today - (PACE_DAYS - 1 - i) * DAY_MS), i]),
  );
  const closedPerDay = Array.from({ length: PACE_DAYS }, () => 0);
  for (const at of input.closedAt) {
    const i = index.get(at.slice(0, 10));
    if (i !== undefined) closedPerDay[i]!++;
  }
  const none = { closedPerDay, paceDate: null };
  if (input.total === 0 || input.deferred) return { ...none, line: "" };
  if (input.open === 0) {
    const last = input.closedAt.reduce((m, a) => (a > m ? a : m), "");
    return { ...none, line: last === "" ? "" : `done ${last.slice(0, 10)}` };
  }
  if (input.closedInWindow === 0)
    return { ...none, line: `no movement in ${input.window} days` };
  const paceDate = dayOf(today + input.days * DAY_MS);
  return { closedPerDay, paceDate, line: `on pace for ${paceDate}` };
}
