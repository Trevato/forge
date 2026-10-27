/**
 * Is the forge clogged (#6516)? A pure read over plain numbers: a clog is
 * declared when a threshold is crossed, and each reason names the threshold.
 */

export const CLOG_CONFLICTED = 10;
export const CLOG_MIN_OPENED = 10;
export const CLOG_LANDING_RATIO = 0.5;
export const CLOG_APPROVED_HOURS = 24;

export interface ClogInput {
  /** Open pulls that conflict with their base. */
  readonly conflicted: number;
  /** Pulls opened over the last 2 h. */
  readonly opened: number;
  /** Pulls landed over the last 2 h. */
  readonly landed: number;
  /** Hours the oldest approved pull has waited. */
  readonly oldestApprovedHours: number;
}

export interface Clog {
  readonly clogged: boolean;
  readonly reasons: readonly string[];
}

export function clogOf(input: ClogInput): Clog {
  const { conflicted, opened, landed, oldestApprovedHours } = input;
  const reasons: string[] = [];
  if (conflicted > CLOG_CONFLICTED) reasons.push(`${conflicted} pulls conflict (more than ${CLOG_CONFLICTED})`);
  if (opened >= CLOG_MIN_OPENED && landed < opened * CLOG_LANDING_RATIO) {
    reasons.push(`${landed} landed of ${opened} opened over 2 h (under ${CLOG_LANDING_RATIO * 100}%)`);
  }
  if (oldestApprovedHours > CLOG_APPROVED_HOURS) {
    reasons.push(`oldest approved pull has waited ${oldestApprovedHours} h (more than ${CLOG_APPROVED_HOURS} h)`);
  }
  return { clogged: reasons.length > 0, reasons };
}
