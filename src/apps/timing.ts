/**
 * Where a deploy's time went, step by step, in the words its log uses.
 *
 * A deploy is a short line of steps — a turn at the gate, reading the
 * manifest, the checkout, the data, then the process — and the one number
 * the log used to print ("serving … 21.8s after the deploy started") cannot
 * say which of them held it. A stopwatch takes a lap at the end of each
 * step and prints them all on one `timing:` line, so a slow start is
 * attributed rather than guessed.
 */

/** Seconds to one decimal place: `3.4s`. */
export const seconds = (ms: number): string =>
  `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export class Stopwatch {
  private readonly from: number;
  private last: number;
  private readonly laps: { name: string; ms: number }[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.from = now();
    this.last = this.from;
  }

  /** End the step called `name`: it took the time since the previous lap. */
  lap(name: string): void {
    const at = this.now();
    this.laps.push({ name, ms: at - this.last });
    this.last = at;
  }

  /** Milliseconds since the stopwatch started. */
  elapsed(): number {
    return this.now() - this.from;
  }

  /**
   * `timing: <what> 0.4s after the deploy started — turn 0.0s · checkout
   * 0.3s · …`, every lap so far in the order it was taken. `since` names
   * the start in the line's words; a run says "the run started". `running`
   * names a step not yet over, shown with the time it has taken so far.
   */
  line(what: string, since = "the deploy started", running?: string): string {
    const laps = [...this.laps];
    // The step still going, counted to now without taking its lap.
    if (running !== undefined) laps.push({ name: running, ms: this.now() - this.last });
    const steps = laps.map((l) => `${l.name} ${seconds(l.ms)}`).join(" · ");
    return `timing: ${what} ${seconds(this.elapsed())} after ${since}${steps === "" ? "" : ` — ${steps}`}`;
  }
}
