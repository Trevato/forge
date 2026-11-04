/**
 * Builder slots serve the roadmap first (#7571). Cheap pulls — a test that
 * pins something, a small terminal or MCP addition — are quick to start and
 * quick to land, so left alone they fill every slot and the open-pull limit
 * while the roadmap waits. Two rules keep them in their place:
 *
 * - **Pick order:** the order Next up shows, ranked rows then the ready tail
 *   (`pickOrder` in core/next_up.ts); the picker has no order of its own.
 * - **A cap:** small issues hold at most `slots.smallShare` percent of the
 *   builder slots (rounded up, so one slot may still take one). At the cap a
 *   small issue is skipped, never waited on: the slot goes to other work or
 *   stays free.
 *
 * Small is read from the issue alone: a title like "A test pins …" or
 * "Tests: …", or a label `test`, `tests`, `tests-only`, `small` or `polish`. Plain data in,
 * plain data out; the reads are two grouped queries whatever the count.
 */

import type { Database } from "bun:sqlite";
import { labelsForIssues } from "../core/issues.ts";

/** Titles that say an issue only pins a behaviour with a test, or is a small addition. */
const SMALL_TITLE = /^(a test (pins|proves|shows|names|covers)\b|tests?( only)?:|small:)/i;
/** Labels that say the same. */
const SMALL_LABELS = new Set(["test", "tests", "tests-only", "small", "polish"]);
/** Whether an issue's title or labels mark it tests-only or a small addition. */
export function isSmall(title: string, labels: readonly string[]): boolean {
  return SMALL_TITLE.test(title.trim()) || labels.some((l) => SMALL_LABELS.has(l.toLowerCase()));
}

/** How many slots small issues may hold: `share` percent of `slots`, rounded up; 5 at 30% is 2. */
export function smallCap(slots: number, share: number): number {
  if (slots <= 0 || share <= 0) return 0;
  return Math.min(slots, Math.ceil((slots * Math.min(share, 100)) / 100));
}

/** `1/2`: small issues in flight of what they may hold; each door adds its own word around it. */
export function shareWords(running: number, cap: number): string {
  return `${running}/${cap}`;
}

/** `small issues: 1 of 2 slots`, for the app's row in Today on /boards. */
export function smallIssuesWords(share: { readonly running: number; readonly cap: number }): string {
  return `small issues: ${share.running} of ${share.cap} ${share.cap === 1 ? "slot" : "slots"}`;
}

export interface Classed {
  /** On the owner's ranked list (#8694): never held back by the cap, small or not. */
  readonly ranked?: boolean;
  readonly small: boolean;
}

/**
 * The order is not decided here: `ordered` arrives in the order Next up shows
 * (#8826) and keeps it. All this does is leave small work out — raised or
 * not, unless the owner ranked it — once `running` small issues fill `cap`.
 */
export function slotOrder<T>(
  ordered: readonly T[],
  classOf: (t: T) => Classed,
  running: number,
  cap: number,
): T[] {
  const open = running < cap;
  return ordered.filter((t) => {
    const c = classOf(t);
    return open || c.ranked === true || !c.small;
  });
}

/** Which of these issues are small, from their titles and labels. */
export function smallIssues(
  db: Database,
  issues: readonly { readonly id: string; readonly title: string }[],
): Set<string> {
  const labels = labelsForIssues(db, issues.map((i) => i.id));
  return new Set(
    issues
      .filter((i) => isSmall(i.title, (labels.get(i.id) ?? []).map((l) => l.name)))
      .map((i) => i.id),
  );
}

/** Of these issue ids, the small ones: what the slotted runs are working on. */
export function smallOfIds(db: Database, ids: readonly string[]): number {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const rows = db
    .query<{ id: string; title: string }, string[]>(
      `SELECT id, title FROM issue WHERE id IN (${unique.map((_, n) => `?${n + 1}`).join(",")})`,
    )
    .all(...unique);
  return smallIssues(db, rows).size;
}

/** The week polish is counted over: the seven days before `now`, on the clock the caller passes. */
export const POLISH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Polish share bounds, in percent of the week's agent spend (#8853). */
export const POLISH_SHARE_MAX = 50;
export const POLISH_SHARE_DEFAULT = 10;

/** Whether a stored polish share is a whole number of percent, 0 to 50. */
export function validPolishShare(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= POLISH_SHARE_MAX;
}

/** Polish is an issue labelled `polish` or one in the small-fixes lane (`isSmall`). */
export function isPolish(title: string, labels: readonly string[]): boolean {
  return labels.some((l) => l.toLowerCase() === "polish") || isSmall(title, labels);
}

export interface PolishSpend {
  /** Agent spend this week on polish issues, USD. */
  readonly polishUsd: number;
  /** Agent spend this week on everything, USD. */
  readonly totalUsd: number;
  /** The setting, percent. */
  readonly share: number;
  /** polishUsd as a percent of totalUsd; 0 while nothing was spent. */
  readonly percent: number;
  /** Whether a ready polish issue may be picked now. */
  readonly under: boolean;
}

/**
 * Polish spent against its share: polish USD / total USD this week, in percent (agent runs started in
 * the window). Under means polish may start: the share is above 0 and polish has spent
 * less than `share` percent of the total — with nothing spent yet, any share above 0 is under.
 */
export function polishPosition(polishUsd: number, totalUsd: number, share: number): PolishSpend {
  const percent = totalUsd > 0 ? (polishUsd / totalUsd) * 100 : 0;
  const under = share > 0 && (totalUsd <= 0 || polishUsd * 100 < share * totalUsd);
  return { polishUsd, totalUsd, share, percent, under };
}

/** This week's polish spend for a repository, read from its agent runs in the seven days before `now`. */
export function polishSpend(db: Database, repoId: string, share: number, now: Date): PolishSpend {
  const from = new Date(now.getTime() - POLISH_WINDOW_MS).toISOString();
  const rows = db
    .query<{ issue_id: string; title: string; usd: number }, [string, string, string]>(
      `SELECT r.issue_id, COALESCE(i.title, '') AS title, SUM(r.cost_usd) AS usd FROM run r
         LEFT JOIN issue i ON i.id = r.issue_id
        WHERE r.repo_id = ?1 AND r.kind = 'agent' AND r.started_at >= ?2 AND r.started_at <= ?3
        GROUP BY r.issue_id`,
    )
    .all(repoId, from, now.toISOString());
  const labels = labelsForIssues(db, rows.flatMap((r) => (r.issue_id === null ? [] : [r.issue_id])));
  let polish = 0;
  let total = 0;
  for (const r of rows) {
    total += r.usd;
    if (r.issue_id !== null && isPolish(r.title, (labels.get(r.issue_id) ?? []).map((l) => l.name))) polish += r.usd;
  }
  return polishPosition(polish, total, share);
}

/** `polish 4% of 10% this week ($1.20 of $30.00)`, for the week page and the MCP tool. */
export function polishWords(p: PolishSpend): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return `polish ${p.percent.toFixed(1)}% of ${p.share}% this week (${usd(p.polishUsd)} of ${usd(p.totalUsd)}): ${p.under ? "ready polish may start" : "no polish starts until it is under"}`;
}
