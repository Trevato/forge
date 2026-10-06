/**
 * A repository's pillars (#612): what its direction says the work is for,
 * read from the issues that stand for them. Nothing is stored. A pillar is
 * an open umbrella issue whose title starts with its name, `P0 Trust: …`,
 * and an issue serves the pillar whose umbrella waits for it. Work that
 * serves none waits behind the Later gate, the open issue whose title starts
 * `Later gate:`, and stands under the Later umbrella (`Later: …`) where the
 * repository keeps one.
 *
 * A title is not enough, because anyone who may open an issue may write one.
 * An issue stands for a pillar, the gate or the Later umbrella only when a
 * person who writes the repository opened it here: not an agent, not someone
 * who can only read, and not an issue imported from an origin under another
 * name. So a stranger's "P0 …" on a public repository makes no pillar, and
 * their "Later gate: …" holds nothing and opens nothing.
 *
 * This module is the one reader: which pillars there are (`pillarsOf`),
 * which of them an issue serves (`servedBy`), and what merged for each
 * (`mergedByPillar`, #610). The label an issue carries is that reading made
 * visible, written by `actions/pillars.ts` and never read back here.
 *
 * A repository with no such issues has no pillars, and plans as it always
 * did.
 */

import type { Database } from "bun:sqlite";
import { getIssuesByIds, type Issue } from "./issues.ts";
import { closesFromBody } from "./pulls.ts";
import { canWrite, type Repo } from "./repos.ts";
import { getUserById } from "./users.ts";

export interface Pillar {
  /** `P0`. */
  readonly short: string;
  /** `P0 Trust`: the umbrella's title as far as its colon. */
  readonly name: string;
  /** The issue that waits for everything serving this pillar. */
  readonly umbrella: Issue;
}

export interface Pillars {
  /** In the order of their short names; empty where the direction names none. */
  readonly pillars: readonly Pillar[];
  /** What everything deferred waits for. */
  readonly gate: Issue | undefined;
  /** The umbrella deferred work stands under. */
  readonly later: Issue | undefined;
}

const PILLAR = /^(P\d+) [^:]+(?=:)/;
const GATE = /^Later gate:/i;
const LATER_UMBRELLA = /^Later:/i;
/** More umbrellas than a direction has pillars. */
const MAX = 64;

/** An open issue, written here by a person, that is titled like an umbrella or the gate. */
const TITLED = `issue.repo_id = ?1 AND issue.kind = 'issue' AND issue.state = 'open'
  AND issue.origin_author IS NULL
  AND (issue.title GLOB 'P[0-9]*' OR issue.title LIKE 'Later%')`;

/** The pillars, the Later gate and the Later umbrella of one repository. */
export function pillarsOf(db: Database, repo: Repo): Pillars {
  // Who among the people that opened such an issue writes the repository.
  // Asked per author, not per issue, and before the cap: however many
  // issues a stranger opens, none of them takes a real umbrella's place.
  const writers = db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT issue.author_id AS id
         FROM issue JOIN user ON user.id = issue.author_id
        WHERE ${TITLED} AND user.kind = 'user' AND user.is_agent = 0`,
    )
    .all(repo.id)
    .map((row) => row.id)
    .filter((id) => canWrite(db, repo, getUserById(db, id)));
  if (writers.length === 0)
    return { pillars: [], gate: undefined, later: undefined };
  const ids = db
    .query<{ id: string }, (string | number)[]>(
      `SELECT issue.id FROM issue
        WHERE ${TITLED}
          AND issue.author_id IN (${writers.map((_, i) => `?${i + 3}`).join(",")})
        ORDER BY issue.number LIMIT ?2`,
    )
    .all(repo.id, MAX, ...writers)
    .map((row) => row.id);
  const issues = [...getIssuesByIds(db, ids).values()].sort(
    (a, b) => a.number - b.number,
  );
  const pillars = new Map<string, Pillar>();
  let gate: Issue | undefined;
  let later: Issue | undefined;
  for (const issue of issues) {
    const named = PILLAR.exec(issue.title);
    // The oldest umbrella of a name is the pillar; a second is a duplicate.
    if (named?.[1] !== undefined && !pillars.has(named[1]))
      pillars.set(named[1], {
        short: named[1],
        name: named[0],
        umbrella: issue,
      });
    else if (GATE.test(issue.title)) gate ??= issue;
    else if (LATER_UMBRELLA.test(issue.title)) later ??= issue;
  }
  return {
    pillars: [...pillars.values()].sort(
      (a, b) => Number(a.short.slice(1)) - Number(b.short.slice(1)),
    ),
    gate,
    later,
  };
}

/** The pillar `text` names, by its short form or its name, in any case. */
export function findPillar(
  pillars: readonly Pillar[],
  text: string,
): Pillar | undefined {
  const wanted = text.trim().toLowerCase();
  return pillars.find(
    (pillar) =>
      pillar.short.toLowerCase() === wanted ||
      pillar.name.toLowerCase() === wanted,
  );
}

// ---- which pillar an issue serves, and what merged for each (#610) ----

/** What an issue that serves no pillar reads as. */
export const NO_PILLAR = "no pillar";
/** What deferred work reads as: the Later umbrella's name, and its label's. */
export const LATER = "Later";
/** The days of merged work the map and the board count by pillar. */
export const PILLAR_DAYS = 7;

/**
 * The names an issue can be filed under, in order: every pillar, then
 * `Later` where the repository has a gate or a Later umbrella.
 */
export function pillarNames(set: Pillars): string[] {
  return [
    ...set.pillars.map((pillar) => pillar.name),
    ...(set.gate !== undefined || set.later !== undefined ? [LATER] : []),
  ];
}

/**
 * Whether an issue is the plan's own furniture — an umbrella, the gate, or
 * the Later umbrella — and not work: it serves no pillar and is counted in
 * none. One umbrella waiting for another is an order between pillars.
 */
export function isStructural(set: Pillars, issueId: string): boolean {
  return (
    set.gate?.id === issueId ||
    set.later?.id === issueId ||
    set.pillars.some((pillar) => pillar.umbrella.id === issueId)
  );
}

/** The ids of the plan's furniture: every umbrella, the Later umbrella and the gate. */
export function structuralIds(set: Pillars): Set<string> {
  return new Set([
    ...set.pillars.map((pillar) => pillar.umbrella.id),
    ...(set.later === undefined ? [] : [set.later.id]),
    ...(set.gate === undefined ? [] : [set.gate.id]),
  ]);
}

/**
 * Why the plan's furniture is never the crew's to take, as the map says it.
 * An umbrella says what work is for and the gate holds work back: closing
 * one is a person's decision — closing the gate opens everything deferred.
 */
export const PLAN_OWN =
  "the plan's own: a person closes it, the crew never picks it";

/**
 * What every issue of the repository serves, by issue id: the first pillar,
 * in order, whose umbrella waits for it directly; else `Later`, when it
 * waits behind the gate or stands under the Later umbrella. An umbrella
 * reads as its own pillar. An issue with no entry serves none. Two reads.
 */
export function servedBy(db: Database, set: Pillars): Map<string, string> {
  const out = new Map<string, string>();
  const place = new Map<string, number>();
  const name = new Map<string, string>();
  set.pillars.forEach((pillar, n) => {
    place.set(pillar.umbrella.id, n);
    name.set(pillar.umbrella.id, pillar.name);
  });
  if (set.later !== undefined) {
    place.set(set.later.id, set.pillars.length);
    name.set(set.later.id, LATER);
  }
  const best = new Map<string, number>();
  if (place.size > 0) {
    const umbrellas = [...place.keys()];
    const rows = db
      .query<{ umbrella: string; id: string }, string[]>(
        `SELECT d.issue_id AS umbrella, d.blocked_by_id AS id
           FROM issue_dependency d
          WHERE d.issue_id IN (${umbrellas.map((_, n) => `?${n + 1}`).join(",")})`,
      )
      .all(...umbrellas);
    for (const row of rows) {
      if (isStructural(set, row.id)) continue;
      const n = place.get(row.umbrella)!;
      if ((best.get(row.id) ?? Number.MAX_SAFE_INTEGER) > n) {
        best.set(row.id, n);
        out.set(row.id, name.get(row.umbrella)!);
      }
    }
  }
  if (set.gate !== undefined) {
    const waiting = db
      .query<{ id: string }, [string]>(
        "SELECT issue_id AS id FROM issue_dependency WHERE blocked_by_id = ?1",
      )
      .all(set.gate.id);
    for (const row of waiting)
      if (!out.has(row.id) && !isStructural(set, row.id))
        out.set(row.id, LATER);
  }
  for (const pillar of set.pillars) out.set(pillar.umbrella.id, pillar.name);
  if (set.later !== undefined) out.set(set.later.id, LATER);
  return out;
}

/** Merged pulls counted for one pillar; `pillar` null is no pillar. */
export interface MergedCount {
  readonly pillar: string | null;
  readonly merged: number;
}

/**
 * The repository's pulls merged since an instant, counted by pillar: a pull
 * takes the pillar of the first issue it closes that serves one. Every name
 * has a row, zero or not, in order; no pillar comes last, when there is
 * any. Two reads however many pulls merged.
 */
export function mergedByPillar(
  db: Database,
  repoId: string,
  set: Pillars,
  served: ReadonlyMap<string, string>,
  since: string,
): MergedCount[] {
  const bodies = db
    .query<{ body: string }, [string, string]>(
      `SELECT i.body FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL AND p.merged_at >= ?2
        ORDER BY p.merged_at DESC LIMIT 1000`,
    )
    .all(repoId, since);
  const closes = bodies.map((row) => closesFromBody(row.body));
  const numbers = [...new Set(closes.flat())];
  const idOf = new Map<number, string>();
  const CHUNK = 400;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk = numbers.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string; number: number }, (string | number)[]>(
        `SELECT id, number FROM issue WHERE repo_id = ?1 AND kind = 'issue'
           AND number IN (${chunk.map((_, n) => `?${n + 2}`).join(",")})`,
      )
      .all(repoId, ...chunk);
    for (const row of rows) idOf.set(row.number, row.id);
  }
  const names = pillarNames(set);
  const counts = new Map<string | null, number>(names.map((n) => [n, 0]));
  for (const closed of closes) {
    let pillar: string | null = null;
    for (const number of closed) {
      const id = idOf.get(number);
      const found = id === undefined ? undefined : served.get(id);
      if (found !== undefined) {
        pillar = found;
        break;
      }
    }
    counts.set(pillar, (counts.get(pillar) ?? 0) + 1);
  }
  const none = counts.get(null);
  return [
    ...names.map((n) => ({ pillar: n, merged: counts.get(n)! })),
    ...(none === undefined ? [] : [{ pillar: null, merged: none }]),
  ];
}

/** Of these repositories, the ones with an open issue titled like an umbrella: one read. */
export function reposWithUmbrellas(
  db: Database,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < repoIds.length; i += CHUNK) {
    const chunk = repoIds.slice(i, i + CHUNK);
    const rows = db
      .query<{ repo_id: string }, string[]>(
        `SELECT DISTINCT repo_id FROM issue
          WHERE repo_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})
            AND kind = 'issue' AND state = 'open'
            AND (title GLOB 'P[0-9]*' OR title LIKE 'Later%')`,
      )
      .all(...chunk);
    for (const row of rows) out.add(row.repo_id);
  }
  return out;
}

/** When the window the map and the board count merged work over began. */
export function pillarWindowStart(now = new Date()): string {
  return new Date(now.getTime() - PILLAR_DAYS * 86_400_000).toISOString();
}

/** A repository's pillars as a surface reads them. */
export interface PillarView {
  readonly set: Pillars;
  /** Every name an issue can be filed under, in order. */
  readonly names: readonly string[];
  /** What each issue serves, by issue id. */
  readonly of: ReadonlyMap<string, string>;
  /** Pulls merged in the last `PILLAR_DAYS` days, by pillar. */
  readonly merged: readonly MergedCount[];
}

/**
 * One repository's pillars, what each of its issues serves, and the week's
 * merged work by pillar — or nothing, for a repository that has no pillars.
 */
export function pillarView(
  db: Database,
  repo: Repo,
  now = new Date(),
): PillarView | undefined {
  const set = pillarsOf(db, repo);
  if (set.pillars.length === 0) return undefined;
  const of = servedBy(db, set);
  return {
    set,
    names: pillarNames(set),
    of,
    merged: mergedByPillar(db, repo.id, set, of, pillarWindowStart(now)),
  };
}
