/**
 * Builder slots serve the roadmap first (#7571). Cheap pulls — a test that
 * pins something, a small terminal or MCP addition — are quick to start and
 * quick to land, so left alone they fill every slot and the open-pull limit
 * while the roadmap waits. Two rules keep them in their place:
 *
 * - **Pick order:** what the owner raised again stays on top, as the map
 *   ranks it (#654); then an issue under an open epic or a P0/P1 pillar,
 *   then other roadmap-sized work, then the small ones; each keeps the
 *   map's order among its own.
 * - **A cap:** small issues hold at most `slots.smallShare` percent of the
 *   builder slots (rounded up, so one slot may still take one). At the cap a
 *   small issue is skipped, never waited on: the slot goes to other work or
 *   stays free.
 *
 * Small is read from the issue alone: a title like "A test pins …" or
 * "Tests: …", or a label `test`, `tests`, `tests-only` or `small`. Plain data in,
 * plain data out; the reads are two grouped queries whatever the count.
 */

import type { Database } from "bun:sqlite";
import { labelsForIssues } from "../core/issues.ts";
import { isStructural, pillarsOf, servedBy } from "../core/pillars.ts";
import type { Repo } from "../core/repos.ts";

/** Titles that say an issue only pins a behaviour with a test, or is a small addition. */
const SMALL_TITLE = /^(a test (pins|proves|shows|names|covers)\b|tests?( only)?:|small:)/i;
/** Labels that say the same. */
const SMALL_LABELS = new Set(["test", "tests", "tests-only", "small"]);
/** The pillars whose work comes first. */
const FIRST_PILLAR = /^P[01] /;

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
  /** Raised again by the owner: on top whatever else it is. */
  readonly raised: boolean;
  /** Under an open epic or a P0/P1 pillar. */
  readonly roadmap: boolean;
  readonly small: boolean;
}

/**
 * The ready list in pick order: what the owner raised again first, then
 * roadmap work, then other, small work last, the map's order kept within
 * each; small work — raised or not — is left out once `running` small
 * issues fill `cap`.
 */
export function slotOrder<T>(
  ready: readonly T[],
  classOf: (t: T) => Classed,
  running: number,
  cap: number,
): T[] {
  const rank = (t: T) => {
    const c = classOf(t);
    return { r: c.raised ? -1 : c.small ? 2 : c.roadmap ? 0 : 1, small: c.small };
  };
  const open = running < cap;
  return ready
    .map((t, at) => ({ t, at, ...rank(t) }))
    .filter((x) => open || !x.small)
    .sort((a, b) => a.r - b.r || a.at - b.at)
    .map((x) => x.t);
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

/**
 * Which of these issues are roadmap work: served by a P0 or P1 pillar, or
 * waited for by an open epic — an open issue other than the plan's furniture.
 */
export function roadmapIssues(db: Database, repo: Repo, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const set = pillarsOf(db, repo);
  const served = servedBy(db, set);
  for (const id of ids) if (FIRST_PILLAR.test(served.get(id) ?? "")) out.add(id);
  const rows = db
    .query<{ id: string; parent: string }, string[]>(
      `SELECT d.blocked_by_id AS id, d.issue_id AS parent
         FROM issue_dependency d JOIN issue i ON i.id = d.issue_id
        WHERE i.state = 'open' AND d.blocked_by_id IN (${ids.map((_, n) => `?${n + 1}`).join(",")})`,
    )
    .all(...ids);
  for (const row of rows) if (!isStructural(set, row.parent)) out.add(row.id);
  return out;
}
