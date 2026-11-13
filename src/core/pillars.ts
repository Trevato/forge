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
/** A title that may be the Later gate or umbrella: what `TITLED` selects for below. */
export const LATER_TITLED = /^later/i;
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
  const { pulls, issues } = mergedPulls(db, repoId, since);
  const names = pillarNames(set);
  const counts = new Map<string | null, number>(names.map((n) => [n, 0]));
  for (const pull of pulls) {
    const pillar = pillarOf(pull.closes, issues, served)?.pillar ?? null;
    counts.set(pillar, (counts.get(pillar) ?? 0) + 1);
  }
  const none = counts.get(null);
  return [
    ...names.map((n) => ({ pillar: n, merged: counts.get(n)! })),
    ...(none === undefined ? [] : [{ pillar: null, merged: none }]),
  ];
}

/** How many ids one query binds; far under SQLite's variable limit. */
const CHUNK = 400;

interface MergedPull {
  readonly id: string;
  readonly closes: readonly number[];
  readonly mergedAt: string;
  readonly mergedOid: string;
}

interface ClosedIssue {
  readonly id: string;
  readonly createdAt: string;
}

type SealedScope = { sealed?: true; sealedBy?: string };

/** The rows of table `t` a viewer may see (`sealed.ts`); `?n` is the reporter's id, bound only when `by` is true. */
function sealedClause(t: string, scope: SealedScope, n: number): string {
  if (scope.sealed === true) return "1";
  return scope.sealedBy === undefined
    ? `${t}.sealed = 0`
    : `(${t}.sealed = 0 OR ${t}.author_id = ?${n})`;
}

/** The parameters `sealedClause` binds: the reporter's id, when it asks for one. */
const sealedParams = (scope: SealedScope): string[] =>
  scope.sealed !== true && scope.sealedBy !== undefined ? [scope.sealedBy] : [];

/** The pulls merged since an instant, and the issues they close, by number. Two reads. */
function mergedPulls(
  db: Database,
  repoId: string,
  since: string,
  scope: SealedScope = {},
): { pulls: MergedPull[]; issues: Map<number, ClosedIssue> } {
  const rows = db
    .query<{ id: string; body: string; at: string; oid: string | null }, string[]>(
      `SELECT i.id, i.body, p.merged_at AS at, p.merged_oid AS oid
         FROM pull p INDEXED BY pull_merged CROSS JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL AND p.merged_at >= ?2
          AND ${sealedClause("i", scope, 3)}
        ORDER BY p.merged_at DESC LIMIT 1000`,
    )
    .all(repoId, since, ...sealedParams(scope));
  const pulls = rows.map((row) => ({
    id: row.id,
    closes: closesFromBody(row.body),
    mergedAt: row.at,
    mergedOid: row.oid ?? "",
  }));
  const numbers = [...new Set(pulls.flatMap((pull) => pull.closes))];
  const issues = new Map<number, ClosedIssue>();
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk = numbers.slice(i, i + CHUNK);
    const found = db
      .query<
        { id: string; number: number; created_at: string },
        (string | number)[]
      >(
        `SELECT id, number, created_at FROM issue WHERE repo_id = ?1 AND kind = 'issue'
           AND ${sealedClause("issue", scope, 2)}
           AND number IN (${chunk.map((_, n) => `?${n + 2 + sealedParams(scope).length}`).join(",")})`,
      )
      .all(repoId, ...sealedParams(scope), ...chunk);
    for (const row of found)
      issues.set(row.number, { id: row.id, createdAt: row.created_at });
  }
  return { pulls, issues };
}

/** The first issue a pull closes that serves a pillar, and that pillar. */
function pillarOf(
  closes: readonly number[],
  issues: ReadonlyMap<number, ClosedIssue>,
  served: ReadonlyMap<string, string>,
): { pillar: string; number: number; createdAt: string } | undefined {
  for (const number of closes) {
    const issue = issues.get(number);
    const pillar = issue === undefined ? undefined : served.get(issue.id);
    if (issue !== undefined && pillar !== undefined)
      return { pillar, number, createdAt: issue.createdAt };
  }
  return undefined;
}

// ---- ask-to-live: an issue opening to its change in production (#1185) ----

/** How long the asking took, for one pillar's merged work. */
export interface AskToLive {
  /** Median hours from an issue opening to its change live in production. */
  readonly medianHours: number;
  /** The one that took longest. */
  readonly slowest: { readonly number: number; readonly hours: number };
}

/** A pillar's ask-to-live; `askToLive` is undefined where nothing merged has gone live. */
export interface AskToLiveCount {
  readonly pillar: string;
  readonly askToLive: AskToLive | undefined;
}

/**
 * Per pillar, over the pulls merged since an instant: the median and the
 * slowest ask-to-live, from the creation of the issue that pull closed to
 * the first production deploy that went live carrying the pull (the
 * `deploy_pull` record, so no git runs here). A pull not yet live counts
 * for nothing; an issue closed by several pulls counts once, at its first
 * time live. Every name has a row, in order; a fixed number of reads however
 * many pulls (the window's pulls and their issues, then the deploys carrying them).
 */
export function askToLiveByPillar(
  db: Database,
  repoId: string,
  set: Pillars,
  served: ReadonlyMap<string, string>,
  since: string,
  scope: SealedScope = {},
): AskToLiveCount[] {
  const { pulls, issues } = mergedPulls(db, repoId, since, scope);
  const firstLive = firstLiveOf(db, repoId, since);
  // One entry per asked issue: its first time live over every pull that closed it.
  const first = new Map<number, { pillar: string; createdAt: string; at: string }>();
  for (const pull of pulls) {
    const ask = pillarOf(pull.closes, issues, served);
    if (ask === undefined) continue;
    const at = firstLive(pull.id, pull.mergedAt);
    if (at === undefined) continue;
    const seen = first.get(ask.number);
    if (seen === undefined || at < seen.at)
      first.set(ask.number, { pillar: ask.pillar, createdAt: ask.createdAt, at });
  }
  const asked = new Map<string, { number: number; hours: number }[]>();
  for (const [number, f] of first) {
    const hours = (Date.parse(f.at) - Date.parse(f.createdAt)) / 3_600_000;
    if (!Number.isFinite(hours)) continue;
    const list = asked.get(f.pillar) ?? [];
    list.push({ number, hours: Math.max(0, hours) });
    asked.set(f.pillar, list);
  }
  return pillarNames(set).map((pillar) => {
    const list = (asked.get(pillar) ?? []).sort((a, b) => a.hours - b.hours);
    if (list.length === 0) return { pillar, askToLive: undefined };
    const mid = list.length >> 1;
    const median =
      list.length % 2 === 1
        ? list[mid]!.hours
        : (list[mid - 1]!.hours + list[mid]!.hours) / 2;
    const slowest = list[list.length - 1]!;
    return {
      pillar,
      askToLive: {
        medianHours: round1(median),
        slowest: { number: slowest.number, hours: round1(slowest.hours) },
      },
    };
  });
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * When a merged pull first went live: the first successful production deploy
 * since `since`, at or after its merge, that carries it. `deploy_pull` is
 * cumulative (every deploy records every merged pull its commit contains), so
 * reading a pull's rows reads one per later deploy: on trevato/forge, 992
 * pulls by 644 deploys in a week were ~320k rows and 1.8 s (#8381). So the
 * window's deploys are read once in time order, and each pull probes the
 * first few from its merge on by primary key — the first one tried almost
 * always carries it. A pull none of those carry (not live yet, or behind a
 * lagging deploy) reads its own rows instead, which are few or none. Three
 * statements however many pulls.
 */
function firstLiveOf(
  db: Database,
  repoId: string,
  since: string,
): (pullId: string, mergedAt: string) => string | undefined {
  const deploys = db
    .query<{ id: string; at: string }, [string, string]>(
      `SELECT id, COALESCE(serving_at, finished_at) AS at FROM run INDEXED BY run_deploy_live_at
        WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production' AND state = 'ok'
          AND COALESCE(serving_at, finished_at) >= ?2
        ORDER BY 2, id`,
    )
    .all(repoId, since);
  const carries = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM deploy_pull WHERE run_id = ?1 AND issue_id = ?2",
  );
  const rest = db.query<{ at: string | null }, [string, string, string]>(
    `SELECT MIN(COALESCE(r.serving_at, r.finished_at)) AS at
       FROM deploy_pull dp CROSS JOIN run r ON r.id = dp.run_id
      WHERE dp.issue_id = ?3 AND r.repo_id = ?1 AND r.kind = 'deploy'
        AND r.env = 'production' AND r.state = 'ok'
        AND COALESCE(r.serving_at, r.finished_at) >= ?2`,
  );
  return (pullId, mergedAt) => {
    // The first deploy at or after the merge: ISO instants sort as strings.
    let lo = 0;
    let hi = deploys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deploys[mid]!.at < mergedAt) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < Math.min(lo + PROBES, deploys.length); i++)
      if (carries.get(deploys[i]!.id, pullId) !== null) return deploys[i]!.at;
    if (lo + PROBES >= deploys.length) return undefined;
    const from = mergedAt > since ? mergedAt : since;
    return rest.get(repoId, from, pullId)?.at ?? undefined;
  };
}

/** Deploys a pull probes from its merge on before it reads its own rows. */
const PROBES = 4;

/** Of these repositories, the ones with an open issue titled like an umbrella: one read. */
export function reposWithUmbrellas(
  db: Database,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
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
  const since = pillarWindowStart(now);
  return {
    set,
    names: pillarNames(set),
    of,
    merged: mergedByPillar(db, repo.id, set, of, since),
  };
}

/** A view's ask-to-live over the last `PILLAR_DAYS` days; opt-in, for it reads the deploy record. */
export function askToLiveOf(
  db: Database,
  repo: Repo,
  view: PillarView,
  scope: SealedScope = {},
  now = new Date(),
): AskToLiveCount[] {
  return askToLiveByPillar(
    db,
    repo.id,
    view.set,
    view.of,
    pillarWindowStart(now),
    scope,
  );
}
