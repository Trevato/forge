/**
 * The note posted when a clog clears (#5930): the cause on one line, how long
 * the clog took to be noticed and to clear, and the dollars stranded at the
 * peak. Pure: plain data in, markdown out. Posting it is another module's job.
 */

export interface ClogNoteInput {
  /** Why the clog was declared, one phrase each. */
  readonly reasons: readonly string[];
  /** Epoch ms: when the clog began, when it was declared, when it cleared. */
  readonly startedAt: number;
  readonly detectedAt: number;
  readonly clearedAt: number;
  /** Dollars stranded at the peak; absent or not above zero leaves the line out. */
  readonly strandedUsd?: number | null;
}

const MINUTE = 60_000;
const HOUR_AFTER_MIN = 90;

/** "12 min" up to 90 minutes, then "2.5 h"; a negative or non-finite span reads as 0 min. */
export function duration(ms: number): string {
  const min = Number.isFinite(ms) && ms > 0 ? ms / MINUTE : 0;
  if (min <= HOUR_AFTER_MIN) return `${Math.round(min)} min`;
  return `${(Math.round(min / 6) / 10).toString()} h`;
}

export function clogNote(input: ClogNoteInput): string {
  const why = input.reasons.map((r) => r.trim()).filter(Boolean);
  const lines = [
    `Clog cleared. Cause: ${why.length ? why.join("; ") : "not recorded"}.`,
    "",
    `- Time to detect: ${duration(input.detectedAt - input.startedAt)}`,
    `- Time to clear: ${duration(input.clearedAt - input.detectedAt)}`,
  ];
  const usd = input.strandedUsd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
    lines.push(`- Stranded at peak: $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  }
  return lines.join("\n") + "\n";
}
