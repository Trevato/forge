/**
 * The duty behind #8716: what reviewers keep asking for becomes one issue to
 * automate it. Rules and two indexed reads, no run. Each sweep retires the
 * findings whose check landed, then opens an issue for each finding repeated
 * {@link REPEATS} times this week that has none. At most {@link PER_SWEEP}
 * issues a sweep, and a sweep at most every {@link EVERY_MS} per repository.
 */

import type { App } from "../app.ts";
import { createIssue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { dueGroups, keepFinding, proposalBody, retireLanded } from "../flow/repeats.ts";

export const EVERY_MS = 6 * 3_600_000;
export const PER_SWEEP = 2;

const swept = new Map<string, number>();

export interface RepeatMoves {
  readonly proposed: number[];
  readonly retired: number;
}

export async function sweepRepeats(app: App, repo: Repo, now = new Date()): Promise<RepeatMoves> {
  const last = swept.get(repo.id);
  if (last !== undefined && now.getTime() - last < EVERY_MS) return { proposed: [], retired: 0 };
  swept.set(repo.id, now.getTime());
  const retired = retireLanded(app.db, repo.id, now);
  const proposed: number[] = [];
  for (const g of (await dueGroups(app.db, repo.id, now)).slice(0, PER_SWEEP)) {
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: g.findings[0]!.authorId,
      title: `Automate a review finding as a lint or test: ${g.sample.replace(/\s+/g, " ").slice(0, 80)}`,
      body: proposalBody(g, now),
    });
    if (!made.ok) continue;
    keepFinding(app.db, repo.id, g, made.value.number, now);
    app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: g.findings[0]!.authorId, payload: { number: made.value.number } });
    proposed.push(made.value.number);
  }
  return { proposed, retired };
}
