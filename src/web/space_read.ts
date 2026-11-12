/**
 * What the space draws, read from the forge: one repository's work as
 * `SpaceInput` (`space_model.ts` places it). Reads exactly what the map page
 * reads — the graph, the words, the pillars, the crew's runs — so the two
 * never disagree about what an issue is doing. Respects the viewer's sealed
 * scope; the answer is kept by the forge's write clock like the map's.
 *
 * Assumption shown on the page: the week's landed work is the closed issues
 * the graph still carries (those on an edge), not every close.
 */

import type { App } from "../app.ts";
import { proposedWork } from "../crew/direct.ts";
import { holdsFor } from "../core/holds.ts";
import { readyNow, repoGraph } from "../core/dependencies.ts";
import { isStructural, pillarView } from "../core/pillars.ts";
import type { Repo } from "../core/repos.ts";
import { listActiveRuns, listRuns, verdictForHead, type Run } from "../core/runs.ts";
import { sealedScope } from "../core/sealed.ts";
import { getUsersByIds, type User } from "../core/users.ts";
import { cachedMap } from "./map_snapshot.ts";
import { marksFor, wordFor } from "./pages/map.ts";
import { buildSpace, WEEK_MS, stateOf, type SpaceInput, type SpaceIssue, type SpaceRun } from "./space_model.ts";

const ms = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso) || 0);

/** A pull head's checks in one word: failed beats running beats ok. */
function checkWord(runs: readonly Run[]): string {
  if (runs.length === 0) return "";
  if (runs.some((r) => r.state === "failed")) return "failed";
  if (runs.some((r) => r.state === "running" || r.state === "queued")) return "running";
  return runs.every((r) => r.state === "ok") ? "ok" : "";
}

export function spaceInput(app: App, repo: Repo, viewer: User | undefined, now: Date): SpaceInput {
  const db = app.db;
  const scope = sealedScope(db, repo, viewer);
  const graph = repoGraph(db, repo.id, { ...scope, lean: true });
  const flying = listActiveRuns(db, [repo.id]);
  const marks = marksFor(db, repo.id, graph, flying);
  const ready = new Set(readyNow(graph).map((r) => r.issue.id));
  const view = pillarView(db, repo, now);
  const index = new Map((view?.names ?? []).map((n, i) => [n, i]));
  const since = now.getTime() - WEEK_MS;

  const pulls = proposedWork(db, repo);
  const holds = holdsFor(db, [...pulls.values()].map((p) => p.id));
  const issues: SpaceIssue[] = [];
  for (const issue of graph.issues) {
    if (view !== undefined && isStructural(view.set, issue.id)) continue;
    if (issue.id === repo.directionIssueId) continue;
    const closedAt = ms(issue.closedAt);
    if (issue.state === "closed" && closedAt < since) continue;
    const name = view?.of.get(issue.id);
    const pull = issue.state === "open" ? pulls.get(issue.number) : undefined;
    issues.push({
      number: issue.number,
      title: issue.title.slice(0, 140),
      pillar: name === undefined ? -1 : (index.get(name) ?? -1),
      state: stateOf(wordFor(issue, ready, marks)),
      createdAt: ms(issue.createdAt),
      closedAt: issue.state === "closed" ? closedAt : 0,
      pull: pull?.number ?? 0,
      hold: pull === undefined ? "" : (holds.get(pull.id)?.why ?? ""),
      check: pull === undefined ? "" : checkWord(verdictForHead(db, pull.id, pull.headOid)),
    });
  }

  const numbers = new Map(graph.issues.map((i) => [i.id, i.number]));
  const runs = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
    (r) => r.actorId !== null && r.issueId !== null && (r.finishedAt === null || ms(r.finishedAt) >= since),
  );
  const who = getUsersByIds(db, runs.map((r) => r.actorId!));
  const crew: SpaceRun[] = [];
  for (const run of runs) {
    const number = numbers.get(run.issueId!);
    const name = who.get(run.actorId!)?.username;
    if (number === undefined || name === undefined) continue;
    const started = ms(run.startedAt) || ms(run.createdAt);
    crew.push({
      actor: name,
      issue: number,
      startedAt: Math.max(started, since),
      endedAt: run.state === "running" || run.state === "queued" ? 0 : ms(run.finishedAt),
    });
  }

  return {
    repo: `${repo.ownerName}/${repo.name}`,
    now: now.getTime(),
    pillars: (view?.names ?? []).map((name) => ({
      name,
      merged: view?.merged.find((m) => m.pillar === name)?.merged ?? 0,
    })),
    issues,
    runs: crew,
  };
}

/** The placed space of `repo` for `viewer`, once per minute while nothing is written. */
export function spaceOf(app: App, repo: Repo, viewer: User | undefined, now = new Date()): Record<string, unknown> {
  return cachedMap(
    app.db,
    { repoId: repo.id, scope: sealedScope(app.db, repo, viewer), now, kind: "space" },
    () => ({ ...buildSpace(spaceInput(app, repo, viewer, now)) }),
  ).value;
}
