/**
 * Keeping an issue's pillar label in step with the plan (`core/pillars.ts`):
 * the one place the forge labels on its own. Nobody is authorised here —
 * each caller already was, to link, to plan or to split — and what changes
 * is announced as the label events a person's own labelling makes.
 *
 * A mirrored repository's labels are its origin's, so nothing here writes
 * one.
 */

import type { App } from "../app.ts";
import { addDependency } from "../core/dependencies.ts";
import { getIssueById, type Issue } from "../core/issues.ts";
import {
  isStructural,
  pillarName,
  pillarOfIssues,
  pillarsOf,
  setPillar,
  syncPillars,
  underUmbrellas,
  type Pillar,
  type PillarChange,
} from "../core/pillars.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isMirror } from "../origins/write-through.ts";

/** Say what `setPillar` changed: a label made, and an issue labelled. */
export function announcePillar(
  app: App,
  actor: User,
  repo: Repo,
  issue: Issue,
  change: PillarChange,
): void {
  if (change.made !== undefined)
    app.bus.append({
      kind: "label.created",
      repoId: repo.id,
      actorId: actor.id,
      payload: { labelId: change.made.id, name: change.made.name },
    });
  app.bus.append({
    kind: `${issue.kind}.labeled`,
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: issue.number, labels: change.labels },
  });
}

/**
 * `issue` was just linked under `waiter`, or taken out from under it. When
 * `waiter` is a pillar's umbrella, the issue's label follows the edges: the
 * pillar it is under now, or none.
 */
export function followUmbrella(
  app: App,
  actor: User,
  repo: Repo,
  waiter: Issue,
  issue: Issue,
): void {
  if (pillarName(waiter.title) === undefined || isMirror(app, repo)) return;
  const pillars = pillarsOf(app.db, repo);
  if (!pillars.some((p) => p.issueId === waiter.id)) return;
  if (isStructural(pillars, issue)) return;
  const under = underUmbrellas(app.db, pillars).get(issue.id) ?? null;
  const change = setPillar(app.db, repo.id, pillars, issue.id, under);
  if (change !== undefined) announcePillar(app, actor, repo, issue, change);
}

/**
 * File a new issue under a pillar: its umbrella waits for it, and it
 * carries the label. For a plan's transaction — nothing is announced here;
 * the caller says it once the plan is committed.
 */
export function fileUnder(
  app: App,
  repo: Repo,
  pillars: readonly Pillar[],
  pillar: Pillar,
  issue: Issue,
  actor: User,
): { umbrella: number; change: PillarChange | undefined } | undefined {
  const umbrella = getIssueById(app.db, pillar.issueId);
  if (umbrella === undefined) return undefined;
  if (!addDependency(app.db, umbrella, issue, actor.id).ok) return undefined;
  return {
    umbrella: umbrella.number,
    change: setPillar(app.db, repo.id, pillars, issue.id, pillar),
  };
}

/** An issue was split: each part that names no pillar carries its parent's. */
export function inheritPillar(
  app: App,
  actor: User,
  repo: Repo,
  parent: Issue,
  children: readonly Issue[],
): void {
  if (children.length === 0 || isMirror(app, repo)) return;
  const pillars = pillarsOf(app.db, repo);
  const carried = pillarOfIssues(app.db, pillars, [
    parent.id,
    ...children.map((c) => c.id),
  ]);
  const pillar = pillars.find((p) => p.name === carried.get(parent.id));
  if (pillar === undefined || isStructural(pillars, parent)) return;
  for (const child of children) {
    if (carried.has(child.id)) continue;
    const change = setPillar(app.db, repo.id, pillars, child.id, pillar);
    if (change !== undefined) announcePillar(app, actor, repo, child, change);
  }
}

/**
 * At boot: label what every umbrella already waits for. This repairs the
 * index for edges made before pillars had labels, so it announces nothing,
 * the way reconcile does not. Returns how many issues it labelled.
 */
export function syncAllPillars(app: App): number {
  const repoIds = app.db
    .query<{ repo_id: string }, []>(
      `SELECT DISTINCT repo_id FROM issue
        WHERE kind = 'issue' AND (title GLOB 'P[0-9]*' OR title LIKE 'Later:%')`,
    )
    .all()
    .map((row) => row.repo_id);
  let changed = 0;
  for (const repoId of repoIds) {
    const repo = getRepoById(app.db, repoId);
    if (repo === undefined || isMirror(app, repo)) continue;
    changed += syncPillars(app.db, repo);
  }
  return changed;
}
