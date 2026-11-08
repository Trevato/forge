/**
 * Stale fold (#6521): crew pulls with no push for 7 days, oldest first, each
 * with the note that folds it back into its issue. A pure read over plain data;
 * it only proposes, a person closes. Approved pulls are left out. Nothing shows it yet.
 */

const DAY_MS = 86_400_000;
const STALE_DAYS = 7;

export interface FoldablePull {
  readonly number: number;
  readonly issueNumber: number | null;
  readonly branch: string;
  readonly lastPushAt: string;
  readonly approved: boolean;
}

export interface StaleFold extends FoldablePull {
  readonly days: number;
  /** Null when the pull has no issue to fold back into. */
  readonly note: string | null;
}

export function staleFold(pulls: readonly FoldablePull[], now: Date): StaleFold[] {
  const out: (StaleFold & { at: number })[] = [];
  for (const p of pulls) {
    if (p.approved) continue;
    const at = Date.parse(p.lastPushAt);
    if (!Number.isFinite(at)) continue;
    const days = Math.floor((now.getTime() - at) / DAY_MS);
    if (days < STALE_DAYS) continue;
    const note =
      p.issueNumber === null
        ? null
        : `Folded back: pull #${p.number} had no push for ${days} days; its branch \`${p.branch}\` keeps the work.`;
    out.push({ ...p, days, note, at });
  }
  out.sort((a, b) => a.at - b.at || a.number - b.number);
  return out.map(({ at: _at, ...rest }) => rest);
}
