/**
 * Small work and polish. An issue is small when its title or labels say so
 * (a title like "A test pins …" or "Tests: …", or a label `test`, `tests`,
 * `tests-only`, `small` or `polish`); polish is spent against a share of the
 * week (`polishSpend`). Small work holds no slots of its own: Speed and the
 * pick order bound it like any other work. Plain data in, plain data out.
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
