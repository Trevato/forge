/**
 * Planning mistakes, counted (#6577): of the build runs that ended in the 24
 * hours up to `now`, those that declined their issue, grouped by why. A run
 * declined when its summary starts "Declined:". Pure: rows in, counts out.
 * `done_on_main` is "Declined: already done on main"; `not_on_main` names
 * code or a pull that is not on main yet; `off_direction` says the work is
 * against the vision or direction; everything else declined is `other`.
 * A run ending exactly 24 h ago is in; one in the future is out.
 */

import type { Database } from "bun:sqlite";

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

export const DECLINE_REASONS: readonly DeclineReason[] = ["done_on_main", "not_on_main", "off_direction", "other"];

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
  for (const r of DECLINE_REASONS) {
    const issues = [...new Set(found[r])];
    out[r] = { count: found[r].length, distinct: issues.length, issues: issues.slice(0, SHOWN) };
  }
  return out;
}

export const DECLINE_LABELS: Readonly<Record<DeclineReason, string>> = {
  done_on_main: "already on main",
  not_on_main: "not on main yet",
  off_direction: "off direction",
  other: "other",
};

/** One line, empty when nothing was declined: `Declined in 24 h: 3 already on main (#1, #2), 1 other (#9)`. */
export function declinesSays(result: Declines): string {
  const parts = DECLINE_REASONS.filter((r) => result[r].count > 0).map((r) => {
    const g = result[r];
    const more = g.distinct > g.issues.length ? ", …" : "";
    return `${g.count} ${DECLINE_LABELS[r]} (${g.issues.map((n) => `#${n}`).join(", ")}${more})`;
  });
  return parts.length ? `Declined in 24 h: ${parts.join(", ")}` : "";
}

/** A declined run, named so a page can link to it. */
export interface DeclineRun {
  readonly repo: string;
  readonly runId: string;
  readonly issue: number;
}

export interface DeclineReading {
  readonly says: string;
  readonly groups: Declines;
  /** Per reason, the newest run of each of the first few issues, for the links. */
  readonly runs: Readonly<Record<DeclineReason, readonly DeclineRun[]>>;
}

interface RunRow {
  id: string;
  owner: string;
  name: string;
  number: number;
  summary: string;
  finished_at: string;
}

/**
 * Declined build runs of the last 24 h, newest first. Same `publicOnly` rule as
 * `readVitals`: public repositories alone. One read.
 */
export function readDeclines(db: Database, now = new Date(), publicOnly = false): DeclineReading {
  const to = now.toISOString();
  const from = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = db
    .query<RunRow, [string, string, number]>(
      `SELECT x.id, ro.username AS owner, r.name, i.number, x.summary, x.finished_at
         FROM run x JOIN repo r ON r.id = x.repo_id JOIN user ro ON ro.id = r.owner_id
         JOIN issue i ON i.id = x.issue_id
        WHERE x.kind = 'agent' AND x.reason != 'review' AND x.summary LIKE '%eclined%'
          AND x.finished_at >= ?1 AND x.finished_at <= ?2 AND (?3 = 0 OR r.visibility = 'public')
        ORDER BY x.finished_at DESC`,
    )
    .all(from, to, publicOnly ? 1 : 0);
  const groups = declines(rows.map((r) => ({ issue: r.number, endedAt: r.finished_at, summary: r.summary })), now);
  const runs: Record<DeclineReason, DeclineRun[]> = { done_on_main: [], not_on_main: [], off_direction: [], other: [] };
  for (const r of rows) {
    const reason = declineReason(r.summary);
    if (!reason) continue;
    const list = runs[reason];
    if (list.length < SHOWN && !list.some((x) => x.issue === r.number))
      list.push({ repo: `${r.owner}/${r.name}`, runId: r.id, issue: r.number });
  }
  return { says: declinesSays(groups), groups, runs };
}
