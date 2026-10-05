/**
 * The pillar label: what `core/pillars.ts` reads, made visible on the issue.
 * That module is the one reader — umbrellas and the edges under them,
 * nothing stored — and this is the one writer of the label, which is never
 * read back to decide anything. An issue carries the label of the pillar it
 * serves (`Later` for deferred work), made the first time it is needed, and
 * no other pillar's.
 *
 * It is kept in step where the edges change: a link or an unlink, a plan, a
 * split, and at boot for what was linked before. Nobody is authorised
 * here — each caller already was — and what changes is announced as the
 * label events a person's own labelling makes. A mirrored repository's
 * labels are its origin's, so nothing here writes one.
 */

import type { App } from "../app.ts";
import { addDependency } from "../core/dependencies.ts";
import {
  createLabel,
  getIssuesByIds,
  getLabel,
  labelsFor,
  setIssueLabels,
  type Issue,
  type Label,
} from "../core/issues.ts";
import {
  isStructural,
  LATER,
  pillarNames,
  pillarsOf,
  servedBy,
  type Pillars,
} from "../core/pillars.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isMirror } from "../origins/write-through.ts";

/** One quiet colour per pillar, by its place; `Later` is grey. */
const COLOURS = [
  "b4533a",
  "a8742a",
  "6f7f2e",
  "2f7d5b",
  "2b7a8c",
  "3f67b1",
  "6b55b5",
  "a14b86",
];
const LATER_COLOUR = "6b7280";

function colourOf(names: readonly string[], name: string): string {
  if (name === LATER) return LATER_COLOUR;
  return COLOURS[Math.max(0, names.indexOf(name)) % COLOURS.length]!;
}

/** What `carry` changed: the labels the issue now has, and a label it made. */
interface Carried {
  readonly labels: string[];
  readonly made?: Label;
}

/**
 * Give an issue this pillar's label and no other pillar's — `null` for
 * none. Its other labels stay. Nothing when it already read so.
 */
function carry(
  app: App,
  repoId: string,
  names: readonly string[],
  issueId: string,
  name: string | null,
): Carried | undefined {
  const known = new Set(names.map((n) => n.toLowerCase()));
  const current = labelsFor(app.db, issueId);
  const kept = current.filter((l) => !known.has(l.name.toLowerCase()));
  const carried = current.filter((l) => known.has(l.name.toLowerCase()));
  if (name === null) {
    if (carried.length === 0) return undefined;
    setIssueLabels(
      app.db,
      issueId,
      kept.map((l) => l.id),
    );
    return { labels: kept.map((l) => l.name) };
  }
  if (
    carried.length === 1 &&
    carried[0]!.name.toLowerCase() === name.toLowerCase()
  )
    return undefined;
  let label = getLabel(app.db, repoId, name);
  let made: Label | undefined;
  if (label === undefined) {
    const created = createLabel(app.db, repoId, name, colourOf(names, name));
    if (!created.ok) return undefined;
    label = made = created.value;
  }
  const next = [...kept, label];
  setIssueLabels(
    app.db,
    issueId,
    next.map((l) => l.id),
  );
  return {
    labels: next.map((l) => l.name).sort(),
    ...(made === undefined ? {} : { made }),
  };
}

/** Say what `carry` changed: a label made, and an issue labelled. */
function announce(
  app: App,
  actor: User,
  repo: Repo,
  issue: Issue,
  change: Carried,
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

/** Whether the repository has anything to file under. */
const hasPillars = (set: Pillars): boolean => pillarNames(set).length > 0;

/** A title that could be an umbrella's or the gate's: worth reading the pillars for. */
const FURNITURE = /^(P\d+ |Later)/i;

/** Put these issues' labels in step with what they serve now, and say so. */
function relabel(
  app: App,
  actor: User,
  repo: Repo,
  set: Pillars,
  issues: readonly Issue[],
): void {
  const names = pillarNames(set);
  const served = servedBy(app.db, set);
  for (const issue of issues) {
    if (issue.kind !== "issue" || isStructural(set, issue.id)) continue;
    const change = carry(
      app,
      repo.id,
      names,
      issue.id,
      served.get(issue.id) ?? null,
    );
    if (change !== undefined) announce(app, actor, repo, issue, change);
  }
}

/**
 * `waiter` was just linked to wait for `blocker`, or stopped. When that
 * edge is one the pillars are read from — an umbrella waiting for work, or
 * work waiting behind the gate — both issues' labels follow.
 */
export function followLink(
  app: App,
  actor: User,
  repo: Repo,
  waiter: Issue,
  blocker: Issue,
): void {
  if (!FURNITURE.test(waiter.title) && !FURNITURE.test(blocker.title)) return;
  if (isMirror(app, repo)) return;
  const set = pillarsOf(app.db, repo.id);
  if (!hasPillars(set)) return;
  relabel(app, actor, repo, set, [waiter, blocker]);
}

/**
 * An issue was split: the parts serve what the whole served. Each umbrella
 * that waited for it now waits for its parts too, and the parts' labels
 * follow. (What the whole waited for, the gate included, the parts already
 * wait for: `moveBlockersToChildren`.)
 */
export function inheritPillar(
  app: App,
  actor: User,
  repo: Repo,
  parent: Issue,
  children: readonly Issue[],
): void {
  if (children.length === 0 || isMirror(app, repo)) return;
  const set = pillarsOf(app.db, repo.id);
  if (!hasPillars(set) || isStructural(set, parent.id)) return;
  const umbrellas = [
    ...set.pillars.map((pillar) => pillar.umbrella),
    ...(set.later === undefined ? [] : [set.later]),
  ];
  const waited = new Set(
    app.db
      .query<{ id: string }, [string]>(
        "SELECT issue_id AS id FROM issue_dependency WHERE blocked_by_id = ?1",
      )
      .all(parent.id)
      .map((row) => row.id),
  );
  for (const umbrella of umbrellas) {
    if (!waited.has(umbrella.id)) continue;
    for (const child of children) {
      if (!addDependency(app.db, umbrella, child, actor.id).ok) continue;
      app.bus.append({
        kind: "issue.blocked",
        repoId: repo.id,
        actorId: actor.id,
        payload: { number: umbrella.number, blockedBy: child.number },
      });
    }
  }
  relabel(app, actor, repo, set, children);
}

/**
 * Put every label in one repository in step with what its issues serve:
 * the label on what serves a pillar, off what no longer does. Announces
 * nothing. Returns how many issues changed.
 */
function syncRepo(app: App, repo: Repo): number {
  const set = pillarsOf(app.db, repo.id);
  const names = pillarNames(set);
  if (names.length === 0) return 0;
  const served = servedBy(app.db, set);
  const carrying = app.db
    .query<{ id: string }, string[]>(
      `SELECT il.issue_id AS id FROM issue_label il
         JOIN label l ON l.id = il.label_id
        WHERE l.repo_id = ?1
          AND l.name COLLATE NOCASE IN (${names.map((_, n) => `?${n + 2}`).join(",")})`,
    )
    .all(repo.id, ...names)
    .map((row) => row.id);
  const ids = [...new Set([...served.keys(), ...carrying])];
  const kinds = getIssuesByIds(app.db, ids);
  let changed = 0;
  for (const id of ids) {
    if (isStructural(set, id) || kinds.get(id)?.kind !== "issue") continue;
    if (carry(app, repo.id, names, id, served.get(id) ?? null) !== undefined)
      changed++;
  }
  return changed;
}

/**
 * At boot: label what every umbrella already waits for. This repairs what
 * is derived, for edges made before pillars had labels, so it announces
 * nothing, the way reconcile does not. Returns how many issues it changed.
 */
export function syncAllPillars(app: App): number {
  const repoIds = app.db
    .query<{ repo_id: string }, []>(
      `SELECT DISTINCT repo_id FROM issue
        WHERE kind = 'issue' AND state = 'open'
          AND (title GLOB 'P[0-9]*' OR title LIKE 'Later%')`,
    )
    .all()
    .map((row) => row.repo_id);
  let changed = 0;
  for (const repoId of repoIds) {
    const repo = getRepoById(app.db, repoId);
    if (repo === undefined || isMirror(app, repo)) continue;
    changed += syncRepo(app, repo);
  }
  return changed;
}
