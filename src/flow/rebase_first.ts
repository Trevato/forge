/**
 * Which open pulls to bring up to date first (#6550): at most five that are
 * behind main, approved ones before the rest, then the most landings behind,
 * then the oldest base. Held pulls are never picked. A pure read: plain data in,
 * pull numbers out.
 */

export const REBASE_FIRST = 5;

export interface RebaseDrift {
  readonly number: number;
  /** Landings on main past the pull's base. */
  readonly behind: number;
  /** When the pull's base was the tip of main, epoch ms. */
  readonly baseAt: number;
  readonly approved: boolean;
  readonly held: boolean;
}

export function rebaseFirst(drifts: readonly RebaseDrift[], _now: number): number[] {
  return drifts
    .filter((d) => !d.held && d.behind > 0)
    .sort(
      (a, b) =>
        Number(b.approved) - Number(a.approved) ||
        b.behind - a.behind ||
        a.baseAt - b.baseAt ||
        a.number - b.number,
    )
    .slice(0, REBASE_FIRST)
    .map((d) => d.number);
}
