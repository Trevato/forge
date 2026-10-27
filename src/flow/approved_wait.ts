/**
 * The approved wait per repository (#6552, for #5930): how many approved pulls
 * wait for the merge queue and how long the oldest has waited. Pure: rows in,
 * rows out; `now` is passed in.
 */

const HOUR_MS = 3_600_000;

export interface ApprovedRow {
  readonly repo: string;
  readonly number: number;
  readonly approvedAt: string;
}

export interface ApprovedWait {
  readonly repo: string;
  readonly waiting: number;
  /** Hours the oldest has waited, one decimal; a future approval reads 0. */
  readonly oldestHours: number;
  /** The number of the pull that has waited longest. */
  readonly oldest: number;
}

export function approvedWait(rows: readonly ApprovedRow[], now: Date): ApprovedWait[] {
  const by = new Map<string, { waiting: number; at: number; number: number }>();
  for (const row of rows) {
    const at = Date.parse(row.approvedAt);
    if (Number.isNaN(at)) continue;
    const cur = by.get(row.repo);
    if (!cur) by.set(row.repo, { waiting: 1, at, number: row.number });
    else {
      cur.waiting += 1;
      if (at < cur.at || (at === cur.at && row.number < cur.number)) {
        cur.at = at;
        cur.number = row.number;
      }
    }
  }
  return [...by]
    .map(([repo, v]) => ({
      repo,
      waiting: v.waiting,
      oldestHours: Math.round(Math.max(0, (now.getTime() - v.at) / HOUR_MS) * 10) / 10,
      oldest: v.number,
    }))
    .sort((a, b) => b.oldestHours - a.oldestHours || b.waiting - a.waiting || a.repo.localeCompare(b.repo));
}
