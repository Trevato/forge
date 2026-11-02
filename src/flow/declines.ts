/**
 * Planning mistakes, counted (#6577): of the build runs that ended in the 24
 * hours up to `now`, those that declined their issue, grouped by why. A run
 * declined when its summary starts "Declined:". Pure: rows in, counts out.
 * `done_on_main` is "Declined: already done on main"; `not_on_main` names
 * code or a pull that is not on main yet; `off_direction` says the work is
 * against the vision or direction; everything else declined is `other`.
 * A run ending exactly 24 h ago is in; one in the future is out.
 */

const DAY_MS = 86_400_000;
const SHOWN = 3;

export type DeclineReason = "done_on_main" | "not_on_main" | "off_direction" | "other";

export interface DeclineRow {
  readonly issue: number;
  readonly endedAt: string;
  readonly summary: string;
}

export interface DeclineGroup {
  readonly count: number;
  /** Issues that declined, before the cap; `issues` shows the first few. */
  readonly distinct: number;
  readonly issues: readonly number[];
}

export type Declines = Readonly<Record<DeclineReason, DeclineGroup>>;

const REASONS: readonly DeclineReason[] = ["done_on_main", "not_on_main", "off_direction", "other"];

export function declineReason(summary: string): DeclineReason | null {
  const s = summary.trimStart();
  if (!/^declined\b/i.test(s)) return null;
  if (/^declined:?\s+already done on main/i.test(s)) return "done_on_main";
  if (/\bnot (yet )?(on|in|landed (on|in)|merged (to|into|on|in)) main\b|\bhas not (landed|merged)\b|\bnot (yet )?(landed|merged)\b|\bdepends on\b/i.test(s)) return "not_on_main";
  if (/\boff[- ]direction\b|\bdirection\b|\bvision\b/i.test(s)) return "off_direction";
  return "other";
}

export function declines(rows: readonly DeclineRow[], now: Date): Declines {
  const to = now.getTime();
  const from = to - DAY_MS;
  const found: Record<DeclineReason, number[]> = { done_on_main: [], not_on_main: [], off_direction: [], other: [] };
  for (const row of rows) {
    const at = Date.parse(row.endedAt);
    if (!(at >= from && at <= to)) continue;
    const reason = declineReason(row.summary);
    if (!reason) continue;
    found[reason].push(row.issue);
  }
  const out = {} as Record<DeclineReason, DeclineGroup>;
  for (const r of REASONS) {
    const issues = [...new Set(found[r])];
    out[r] = { count: found[r].length, distinct: issues.length, issues: issues.slice(0, SHOWN) };
  }
  return out;
}

const LABELS: Readonly<Record<DeclineReason, string>> = {
  done_on_main: "already on main",
  not_on_main: "not on main yet",
  off_direction: "off direction",
  other: "other",
};

/** One line, empty when nothing was declined: `Declined in 24 h: 3 already on main (#1, #2), 1 other (#9)`. */
export function declinesSays(result: Declines): string {
  const parts = REASONS.filter((r) => result[r].count > 0).map((r) => {
    const g = result[r];
    const more = g.distinct > g.issues.length ? ", …" : "";
    return `${g.count} ${LABELS[r]} (${g.issues.map((n) => `#${n}`).join(", ")}${more})`;
  });
  return parts.length ? `Declined in 24 h: ${parts.join(", ")}` : "";
}
