/**
 * Pulls one changes-asked round from being handed over (#6591). A pull goes to
 * a person after three changes-requested reviews in a row; the ones at two
 * can be helped a round earlier. Pure: rows in, rows out.
 */

export type Verdict = "approved" | "changes_requested";

export const HANDOVER_RUN = 3;

export interface ReviewRow<P> {
  readonly pull: P;
  /** Review verdicts in time order, oldest first. */
  readonly verdicts: readonly Verdict[];
}

/** The trailing run of changes-requested verdicts since the last approval. */
export function trailingRun(verdicts: readonly Verdict[]): number {
  let run = 0;
  for (let i = verdicts.length - 1; i >= 0 && verdicts[i] === "changes_requested"; i--) run++;
  return run;
}

/** Pulls whose trailing run is exactly two, given in time order; most recent first. */
export function nearHandover<P>(rows: readonly ReviewRow<P>[]): P[] {
  return rows
    .filter((r) => trailingRun(r.verdicts) === HANDOVER_RUN - 1)
    .map((r) => r.pull)
    .reverse();
}
