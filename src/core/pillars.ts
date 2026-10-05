/**
 * Pillars: the few things the owner asked for, and which of them each issue
 * serves. A pillar is an umbrella issue — titled `P0 Trust: …`, or
 * `Later: …` — opened by someone who can write the repository, so the set is
 * fixed by the people who steer it and nobody else can add to it. Its label
 * has the same name and is made the first time it is needed.
 *
 * The label is what every surface reads. The umbrella writes it: an issue
 * the umbrella waits for carries the pillar's label, from the moment it is
 * linked (`actions/pillars.ts`) and, for what was linked before, from boot.
 * An issue carries one pillar at most; one with none reads "no pillar".
 *
 * Pure data: no authz beyond who may name a pillar, no events.
 */

import type { Database } from "bun:sqlite";
import {
  createLabel,
  getLabel,
  labelsFor,
  labelsForIssues,
  setIssueLabels,
  type Label,
} from "./issues.ts";
import { closesFromBody } from "./pulls.ts";
import { canWrite, type Repo } from "./repos.ts";
import { getUsersByIds } from "./users.ts";

/** A pillar's name, as its umbrella's title begins: `P0 Trust`, `Later`. */
const UMBRELLA = /^(P\d{1,2} [^:]{1,48}|Later):/;
/** The gate deferred work waits behind is the plan's own, like an umbrella. */
const GATE = /^Later gate\b/;

/** What an issue that serves no pillar reads as. */
export const NO_PILLAR = "no pillar";

/** The days of merged work the map and the board count by pillar. */
export const PILLAR_DAYS = 7;

export interface Pillar {
  readonly name: string;
  /** The umbrella: what it waits for is the pillar's work. */
  readonly issueId: string;
  readonly number: number;
}

/** The pillar an umbrella's title names, if it is one. */
export function pillarName(title: string): string | undefined {
  return UMBRELLA.exec(title)?.[1];
}

/**
 * Whether an issue is the plan's own furniture — a pillar's umbrella, or
 * the gate — and not work: it is under no pillar and counted in none.
 */
export function isStructural(
  pillars: readonly Pillar[],
  issue: { readonly id: string; readonly title: string },
): boolean {
  return (
    GATE.test(issue.title) || pillars.some((p) => p.issueId === issue.id)
  );
}

/** `P0` before `P1` before `P10`, and `Later` last. */
function order(name: string): number {
  const n = /^P(\d+) /.exec(name);
  return n === null ? Number.MAX_SAFE_INTEGER : Number(n[1]);
}

/**
 * The repository's pillars, in order. An umbrella counts only when whoever
 * opened it can write here: a stranger's issue with the right title names
 * nothing. Two umbrellas with one name are one pillar, the older.
 */
export function pillarsOf(db: Database, repo: Repo): Pillar[] {
  const rows = db
    .query<
      { id: string; number: number; title: string; author_id: string },
      [string]
    >(
      `SELECT id, number, title, author_id FROM issue
        WHERE repo_id = ?1 AND kind = 'issue'
          AND (title GLOB 'P[0-9]*' OR title LIKE 'Later:%')
        ORDER BY number`,
    )
    .all(repo.id)
    .filter((row) => pillarName(row.title) !== undefined);
  if (rows.length === 0) return [];
  const authors = getUsersByIds(
    db,
    rows.map((row) => row.author_id),
  );
  const writes = new Map<string, boolean>();
  const mayName = (authorId: string): boolean => {
    const known = writes.get(authorId);
    if (known !== undefined) return known;
    const author = authors.get(authorId);
    const may = author !== undefined && canWrite(db, repo, author);
    writes.set(authorId, may);
    return may;
  };
  const byName = new Map<string, Pillar>();
  for (const row of rows) {
    const name = pillarName(row.title)!;
    if (byName.has(name.toLowerCase()) || !mayName(row.author_id)) continue;
    byName.set(name.toLowerCase(), {
      name,
      issueId: row.id,
      number: row.number,
    });
  }
  return [...byName.values()].sort(
    (a, b) => order(a.name) - order(b.name) || a.number - b.number,
  );
}

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

function colourOf(name: string): string {
  const n = order(name);
  return n === Number.MAX_SAFE_INTEGER
    ? LATER_COLOUR
    : COLOURS[n % COLOURS.length]!;
}

/** The pillar's label, and whether this call made it: created on first use. */
function pillarLabel(
  db: Database,
  repoId: string,
  pillar: Pillar,
): { label: Label; made: boolean } | undefined {
  const had = getLabel(db, repoId, pillar.name);
  if (had !== undefined) return { label: had, made: false };
  const created = createLabel(db, repoId, pillar.name, colourOf(pillar.name));
  return created.ok ? { label: created.value, made: true } : undefined;
}

/** What `setPillar` changed: nothing, or the labels the issue now carries. */
export interface PillarChange {
  /** The issue's label names after the change. */
  readonly labels: string[];
  /** The pillar label, when this call had to make it. */
  readonly made?: Label;
}

/**
 * Give an issue this pillar and no other — `null` for none. Its other
 * labels stay. Returns what changed, or nothing when it already read so.
 */
export function setPillar(
  db: Database,
  repoId: string,
  pillars: readonly Pillar[],
  issueId: string,
  pillar: Pillar | null,
): PillarChange | undefined {
  const names = new Set(pillars.map((p) => p.name.toLowerCase()));
  const current = labelsFor(db, issueId);
  const kept = current.filter((l) => !names.has(l.name.toLowerCase()));
  const carried = current.filter((l) => names.has(l.name.toLowerCase()));
  if (pillar === null) {
    if (carried.length === 0) return undefined;
    setIssueLabels(
      db,
      issueId,
      kept.map((l) => l.id),
    );
    return { labels: kept.map((l) => l.name) };
  }
  if (
    carried.length === 1 &&
    carried[0]!.name.toLowerCase() === pillar.name.toLowerCase()
  )
    return undefined;
  const found = pillarLabel(db, repoId, pillar);
  if (found === undefined) return undefined;
  const next = [...kept, found.label];
  setIssueLabels(
    db,
    issueId,
    next.map((l) => l.id),
  );
  return {
    labels: next.map((l) => l.name).sort(),
    ...(found.made ? { made: found.label } : {}),
  };
}

/**
 * The pillar each of these issues carries, by issue id: its label, or, for
 * an umbrella, its own name. An issue with none has no entry.
 */
export function pillarOfIssues(
  db: Database,
  pillars: readonly Pillar[],
  issueIds: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (pillars.length === 0 || issueIds.length === 0) return out;
  const place = new Map(pillars.map((p, n) => [p.name.toLowerCase(), n]));
  for (const [issueId, labels] of labelsForIssues(db, issueIds)) {
    let best: number | undefined;
    for (const label of labels) {
      const n = place.get(label.name.toLowerCase());
      if (n !== undefined && (best === undefined || n < best)) best = n;
    }
    if (best !== undefined) out.set(issueId, pillars[best]!.name);
  }
  const asked = new Set(issueIds);
  for (const pillar of pillars)
    if (asked.has(pillar.issueId)) out.set(pillar.issueId, pillar.name);
  return out;
}

/**
 * The pillar each issue is under by the plan's edges: the first umbrella,
 * in order, that waits for it directly. Umbrellas and the gate are the
 * plan's furniture and are under nothing — one umbrella waiting for another
 * is an order between pillars, not membership.
 */
export function underUmbrellas(
  db: Database,
  pillars: readonly Pillar[],
): Map<string, Pillar> {
  const out = new Map<string, Pillar>();
  if (pillars.length === 0) return out;
  const byUmbrella = new Map(pillars.map((p) => [p.issueId, p]));
  const marks = pillars.map((_, n) => `?${n + 1}`).join(",");
  const rows = db
    .query<{ umbrella: string; id: string; title: string }, string[]>(
      `SELECT d.issue_id AS umbrella, b.id, b.title
         FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
        WHERE d.issue_id IN (${marks}) AND b.kind = 'issue'`,
    )
    .all(...pillars.map((p) => p.issueId));
  const place = new Map(pillars.map((p, n) => [p.issueId, n]));
  for (const row of rows) {
    if (isStructural(pillars, row)) continue;
    const had = out.get(row.id);
    if (
      had === undefined ||
      place.get(row.umbrella)! < place.get(had.issueId)!
    )
      out.set(row.id, byUmbrella.get(row.umbrella)!);
  }
  return out;
}

/**
 * Label everything an umbrella already waits for. For what was linked
 * before pillars had labels, and for an umbrella opened over work that was
 * already there. Returns how many issues changed.
 */
export function syncPillars(db: Database, repo: Repo): number {
  const pillars = pillarsOf(db, repo);
  let changed = 0;
  for (const [issueId, pillar] of underUmbrellas(db, pillars))
    if (setPillar(db, repo.id, pillars, issueId, pillar) !== undefined)
      changed++;
  return changed;
}

/** Merged pulls counted for one pillar; `pillar` null is no pillar. */
export interface MergedCount {
  readonly pillar: string | null;
  readonly merged: number;
}

/**
 * The repository's pulls merged since an instant, counted by pillar: a pull
 * takes the pillar of the first issue it closes that has one. Every pillar
 * has a row, zero or not, in order; no pillar comes last, when there is
 * any. Three reads however many pulls merged.
 */
export function mergedByPillar(
  db: Database,
  repo: Repo,
  pillars: readonly Pillar[],
  since: string,
): MergedCount[] {
  const bodies = db
    .query<{ body: string }, [string, string]>(
      `SELECT i.body FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL AND p.merged_at >= ?2
        ORDER BY p.merged_at DESC LIMIT 1000`,
    )
    .all(repo.id, since);
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
      .all(repo.id, ...chunk);
    for (const row of rows) idOf.set(row.number, row.id);
  }
  const pillarOf = pillarOfIssues(db, pillars, [...idOf.values()]);
  const counts = new Map<string | null, number>(
    pillars.map((p) => [p.name, 0]),
  );
  for (const closed of closes) {
    let pillar: string | null = null;
    for (const number of closed) {
      const id = idOf.get(number);
      const found = id === undefined ? undefined : pillarOf.get(id);
      if (found !== undefined) {
        pillar = found;
        break;
      }
    }
    counts.set(pillar, (counts.get(pillar) ?? 0) + 1);
  }
  const none = counts.get(null);
  return [
    ...pillars.map((p) => ({ pillar: p.name, merged: counts.get(p.name)! })),
    ...(none === undefined ? [] : [{ pillar: null, merged: none }]),
  ];
}

/** Of these repositories, the ones with an issue titled like an umbrella: one read. */
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
            AND kind = 'issue'
            AND (title GLOB 'P[0-9]*' OR title LIKE 'Later:%')`,
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
  readonly pillars: readonly Pillar[];
  /** The pillar each issue asked about carries, by issue id. */
  readonly of: ReadonlyMap<string, string>;
  /** Pulls merged in the last `PILLAR_DAYS` days, by pillar. */
  readonly merged: readonly MergedCount[];
}

/**
 * The pillars of one repository, which of them each of these issues
 * carries, and the week's merged work by pillar — or nothing, for a
 * repository that has no pillars.
 */
export function pillarView(
  db: Database,
  repo: Repo,
  issueIds: readonly string[],
  now = new Date(),
): PillarView | undefined {
  const pillars = pillarsOf(db, repo);
  if (pillars.length === 0) return undefined;
  return {
    pillars,
    of: pillarOfIssues(db, pillars, issueIds),
    merged: mergedByPillar(db, repo, pillars, pillarWindowStart(now)),
  };
}
