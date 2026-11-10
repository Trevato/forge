/**
 * Explore (#607): the apps, people and forges a viewer can see, ranked by
 * the same real signals the front page uses (`core/front.ts`: forks by
 * people, pulls merged, hours awake, the last merge), each row with its
 * numbers, narrowed in one line: `kind:app sort:forks garden`. The page,
 * `/api/v1/explore` and the MCP tool `explore` all answer from here.
 *
 * - Only what the viewer may read: repositories by `listReposVisibleTo`; an
 *   agent's working fork is how the crew builds, not something to explore,
 *   so a repository an agent owns is left out.
 * - A private app's hours awake are told only to those who may enter it,
 *   as on the front page.
 * - People are the owners of the apps shown, their numbers summed and
 *   ranked by their best app.
 * - Forges are the children this forge spawned, for a site admin.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { appsForRepos } from "../core/apps.ts";
import { markOf, type Mark } from "../core/marks.ts";
import {
  frontScore,
  frontSignals,
  frontWeights,
  type FrontSignals,
} from "../core/front.ts";
import { isSafeName } from "../git/guard.ts";
import { canEnterApp, listReposVisibleTo, type Repo } from "../core/repos.ts";
import { getUsersByIds, isActive, type User } from "../core/users.ts";
import { rankInputs } from "../core/rank_inputs.ts";
import { writeStamp } from "../core/write_clock.ts";
import { Stamped } from "../kernel/stamped.ts";
import { listChildren } from "./spawn.ts";

export type ExploreKind = "app" | "person" | "forge";
export type ExploreSort =
  | "score"
  | "forks"
  | "ships"
  | "likes"
  | "use"
  | "fresh"
  | "name";

export interface ExploreQuery {
  readonly kind: ExploreKind | "all";
  readonly sort: ExploreSort;
  /** Words a row's name, owner or description must contain. */
  readonly text: string;
  /** `archived:yes` — put-away repositories are in the list; off, they are not. */
  readonly archived: boolean;
  /** `updated:1d|7d|30d` — only rows that moved within the window; `all` is no window. */
  readonly updated: ExploreWindow;
  /** `owner:<name>` — only this account's apps, and the person themself. */
  readonly owner?: string;
}

export type ExploreWindow = "all" | "1d" | "7d" | "30d";
const WINDOWS: Record<string, number> = {
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

const KINDS: Record<string, ExploreKind> = {
  app: "app",
  apps: "app",
  person: "person",
  people: "person",
  forge: "forge",
  forges: "forge",
};
const SORTS: readonly ExploreSort[] = [
  "score",
  "forks",
  "ships",
  "likes",
  "use",
  "fresh",
  "name",
];

/** How many repositories are read, and rows answered. */
const READ = 400;
const ROWS = 60;

/**
 * The one line: `kind:` and `sort:` take a word each; anything else is
 * text to match. An unknown kind or sort is ignored (`readExploreLine`
 * names it), not an error — the line is typed by a person.
 */
export function parseExploreQuery(line: string): ExploreQuery {
  return readExploreLine(line).query;
}

/** The filter names a request may carry as separate parameters (`?kind=app&sort=forks`), beside `q`. */
export const EXPLORE_PARAMS = ["kind", "sort", "updated", "owner", "archived"] as const;

/**
 * The one line a request asks for: `q`, then each separate parameter as its
 * `key:value` word. A value is one word (whitespace removed, so it cannot
 * smuggle in text or another key), and one the line does not take is an
 * unknown word like any other. Parameters win over the same key in `q`.
 */
export function exploreLineFrom(get: (name: string) => string | null | undefined): string {
  const given = new Map<string, string>();
  for (const key of EXPLORE_PARAMS) {
    const value = (get(key) ?? "").replace(/\s+/g, "").slice(0, 100);
    if (value !== "") given.set(key, value);
  }
  // A parameter wins: the same key typed in `q` is dropped, not left to the reader's order.
  const typed = (get("q") ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "" && !(w.includes(":") && given.has(w.slice(0, w.indexOf(":")).toLowerCase())));
  return [...typed, ...[...given].map(([k, v]) => `${k}:${v}`)].join(" ");
}

/** A query as separate URL parameters, the form the page links to; "" for the default view. */
export function exploreParams(query: ExploreQuery): string {
  const p = new URLSearchParams();
  if (query.kind !== "all") p.set("kind", query.kind);
  if (query.sort !== "score") p.set("sort", query.sort);
  if (query.updated !== "all") p.set("updated", query.updated);
  if (query.archived) p.set("archived", "yes");
  if (query.owner !== undefined) p.set("owner", query.owner);
  if (query.text !== "") p.set("q", query.text);
  return p.toString();
}

const EXPLORE_KEYS = /(^|\s)(kind|sort|updated|owner|archived):/i;

/** Whether a line has any word the explorer reads as a key, so every surface takes it as the explorer's. */
export function isExploreLine(line: string): boolean {
  return EXPLORE_KEYS.test(line);
}

/** The query and the `kind:`, `sort:`, `updated:`, `archived:` and `owner:` words it did not take, as typed. */
export interface ExploreRead {
  readonly query: ExploreQuery;
  readonly unknown: readonly string[];
}

export function readExploreLine(line: string): ExploreRead {
  const unknown: string[] = [];
  let kind: ExploreKind | "all" = "all";
  let sort: ExploreSort = "score";
  let archived = false;
  let updated: ExploreWindow = "all";
  let owner: string | undefined;
  const words: string[] = [];
  for (const word of line
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")) {
    const [key, value = ""] = word.split(/:(.*)/s);
    const k = (key ?? "").toLowerCase();
    if (k === "kind" && value !== "") {
      const known = Object.hasOwn(KINDS, value.toLowerCase()) ? KINDS[value.toLowerCase()] : undefined;
      if (known === undefined) unknown.push(word);
      else kind = known;
    } else if (k === "sort" && value !== "") {
      if ((SORTS as readonly string[]).includes(value.toLowerCase()))
        sort = value.toLowerCase() as ExploreSort;
      else unknown.push(word);
    } else if (k === "archived" && value !== "") {
      if (["yes", "no"].includes(value.toLowerCase())) archived = value.toLowerCase() === "yes";
      else unknown.push(word);
    } else if (k === "updated" && value !== "") {
      if (Object.hasOwn(WINDOWS, value.toLowerCase())) updated = value.toLowerCase() as ExploreWindow;
      else unknown.push(word);
    } else if (k === "owner" && value !== "") {
      if (isSafeName(value)) owner = value;
      else unknown.push(word);
    } else if (k === "q" && value !== "") words.push(value);
    else words.push(word);
  }
  return {
    query: {
      kind,
      sort,
      text: words.join(" ").slice(0, 100),
      archived,
      updated,
      ...(owner === undefined ? {} : { owner }),
    },
    unknown: unknown.slice(0, 5),
  };
}

/** The kinds a `kind:` word may be, once each. */
const KIND_WORDS: readonly ExploreKind[] = [...new Set(Object.values(KINDS))];

/**
 * One quiet sentence for the unknown words, naming what is taken; "" when
 * there are none. Plain text: the caller escapes it where it draws it.
 */
export function exploreNote(unknown: readonly string[]): string {
  return unknown
    .map((word) => {
      const key = word.slice(0, word.indexOf(":")).toLowerCase();
      const shown = word.length > 40 ? `${word.slice(0, 39)}…` : word;
      if (key === "owner") return `${shown} is not a name`;
      if (key === "updated") return `${shown} is not a window — use ${Object.keys(WINDOWS).join(", ")}`;
      if (key === "archived") return `${shown} is not an answer — use yes, no`;
      const sort = key === "sort";
      return `${shown} is not a ${sort ? "sort" : "kind"} — use ${(sort ? SORTS : KIND_WORDS).join(", ")}`;
    })
    .join("; ");
}

/** Edit distance between two short words. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The words each key takes. */
function takenBy(key: string): readonly string[] {
  if (key === "kind") return Object.keys(KINDS);
  if (key === "sort") return SORTS;
  if (key === "updated") return Object.keys(WINDOWS);
  if (key === "archived") return ["yes", "no"];
  return [];
}

export interface ExploreSuggestion {
  /** The unknown word as typed. */
  readonly word: string;
  /** The known word it was nearest, `sort:forks`. */
  readonly fix: string;
  /** The whole line with that one word mended. */
  readonly line: string;
}

/**
 * One mended line for the first unknown word within edit distance 2 of a
 * known value of its key; undefined when none is that close. A pure
 * function of the line: nothing is looked up.
 */
export function exploreSuggestion(line: string): ExploreSuggestion | undefined {
  const { unknown } = readExploreLine(line);
  for (const word of unknown) {
    const at = word.indexOf(":");
    const key = word.slice(0, at).toLowerCase();
    const value = word.slice(at + 1).toLowerCase();
    let best: string | undefined;
    // Within 2, and nearer than the word is long: 1–2 characters of junk match anything.
    let near = Math.min(3, value.length);
    for (const known of takenBy(key)) {
      const d = distance(value, known);
      if (d < near) {
        near = d;
        best = known;
      }
    }
    if (best === undefined) continue;
    const fix = `${key}:${best}`;
    const words = line.trim().split(/\s+/);
    return { word, fix, line: words.map((w) => (w === word ? fix : w)).join(" ") };
  }
  return undefined;
}

/** The line a query reads as, for links and the query box. */
export function exploreLine(query: ExploreQuery): string {
  return [
    query.kind === "all" ? "" : `kind:${query.kind}`,
    query.sort === "score" ? "" : `sort:${query.sort}`,
    query.archived ? "archived:yes" : "",
    query.updated === "all" ? "" : `updated:${query.updated}`,
    query.owner === undefined ? "" : `owner:${query.owner}`,
    query.text,
  ]
    .filter((p) => p !== "")
    .join(" ");
}

export interface ExploreRow {
  readonly kind: ExploreKind;
  readonly name: string;
  /** Where the row leads: a repository, a person, another forge. */
  readonly url: string;
  readonly description: string;
  /** For an app and a person; a forge has none of these here. */
  readonly numbers: {
    readonly forks: number;
    readonly ships: number;
    /** Likes on posts about the app, as the viewer may read them. */
    readonly likes: number;
    readonly awakeHours: number;
    readonly apps: number;
  };
  readonly shippedAt: string | null;
  readonly score: number;
  /** An app's repository, for "Make it yours". */
  readonly repo?: { readonly owner: string; readonly name: string };
  /** A person's mark, from their account (`core/marks.ts`): the owner's, never a typed one. */
  readonly mark?: Mark;
  /**
   * Whether this viewer may make the app theirs (#606, #922): signed in, a
   * person, not its owner, and the app one they may copy — public, or a
   * private one they enter as its own. The same rules Make it yours checks.
   */
  readonly copyable?: boolean;
}

/**
 * The ranking as last computed, per viewer (id and admin standing) and line
 * (#3394, #6129). A signed-out viewer has the one key every stranger shares;
 * a signed-in one is keyed by id, which fixes their readable set — so a
 * private app is never served from an entry built for someone who could not
 * read it. Two tiers: while the forge's write clock has not moved, the answer
 * stands without a query; when it has (it moves on every write, ranked or
 * not), `rankInputs` says whether anything the ranking reads changed, and
 * only then is it ranked again. A score ages with the clock, so the answer
 * is ranked again after a minute at most. The spawned forges, which no write
 * clock sees, are read fresh on every call and added to a copy after the kept
 * read. A call at a given `now` is never kept.
 */
const RANK_MAX_AGE_MS = 60_000;
const CLOCK_MAX_AGE_MS = 5_000;
const ranked = new WeakMap<Database, { clock: Stamped<ExploreRow[]>; inputs: Stamped<ExploreRow[]> }>();

export async function explore(
  app: App,
  viewer: User | undefined,
  query: ExploreQuery,
  now?: number,
): Promise<ExploreRow[]> {
  return (await everything(app, viewer, query, now)).slice(0, ROWS);
}

export interface ExplorePage {
  readonly items: readonly ExploreRow[];
  /** Pass back as `cursor` for the page after; null on the last. */
  readonly nextCursor: string | null;
}

/**
 * One page after `cursor` (a `next_cursor` of the page before), or null when
 * the cursor is not one. The cursor holds the last row's sort value, kind and
 * name, so the next page starts after that place in the order even when the
 * row itself has since gone.
 */
export async function explorePage(
  app: App,
  viewer: User | undefined,
  query: ExploreQuery,
  cursor: string | null,
  visible?: (row: ExploreRow) => boolean,
  now?: number,
): Promise<ExplorePage | null> {
  const after = cursor === null ? undefined : readCursor(cursor, query);
  if (after === null) return null;
  // The caller's narrowing comes first, so a page and its cursor only ever
  // hold rows the caller may see.
  const all = await everything(app, viewer, query, now);
  const rows = visible === undefined ? all : all.filter(visible);
  const rest = after === undefined ? rows : rows.filter((r) => compare(r, after, query) > 0);
  const items = rest.slice(0, ROWS);
  return {
    items,
    nextCursor: rest.length > ROWS ? writeCursor(items[items.length - 1]!, query) : null,
  };
}

interface Place {
  readonly key: number | string;
  readonly kind: ExploreKind;
  readonly name: string;
}

const CURSOR_MAX = 400;

function writeCursor(row: ExploreRow, query: ExploreQuery): string {
  const place: [ExploreSort, number | string, ExploreKind, string] = [query.sort, sortKey(row, query.sort), row.kind, row.name];
  return Buffer.from(JSON.stringify(place)).toString("base64url");
}

/** Whether `cursor` is one for this query, answered without reading any rows. */
export const cursorFits = (cursor: string, query: ExploreQuery): boolean => readCursor(cursor, query) !== null;

/** The place a cursor names, undefined never; null when it is not one for this query. */
function readCursor(cursor: string, query: ExploreQuery): Place | null {
  if (cursor.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [sort, key, kind, name] = value as unknown[];
  if (sort !== query.sort) return null;
  const wanted = query.sort === "name" ? "string" : "number";
  if (typeof key !== wanted || (typeof key === "number" && !Number.isFinite(key))) return null;
  if (kind !== "app" && kind !== "person" && kind !== "forge") return null;
  if (typeof name !== "string" || name.length > 200) return null;
  return { key: key as number | string, kind, name };
}

async function everything(
  app: App,
  viewer: User | undefined,
  query: ExploreQuery,
  now?: number,
): Promise<readonly ExploreRow[]> {
  const forgeRows = await forges(app, viewer, query);
  const stamp = now === undefined ? writeStamp(app.db) : undefined;
  if (stamp === undefined) return place(rank(app, viewer, query, now ?? Date.now()), forgeRows, query);
  let tiers = ranked.get(app.db);
  if (tiers === undefined) {
    tiers = {
      clock: new Stamped<ExploreRow[]>({ maxEntries: 64, maxAgeMs: CLOCK_MAX_AGE_MS }),
      inputs: new Stamped<ExploreRow[]>({ maxEntries: 64, maxAgeMs: RANK_MAX_AGE_MS }),
    };
    ranked.set(app.db, tiers);
  }
  const { clock, inputs } = tiers;
  const key = `${viewer?.id ?? ""}\n${viewer?.isAdmin === true ? "admin" : ""}\n${exploreLine(query)}`;
  const kept = clock.get(key, stamp, () =>
    inputs.get(key, rankInputs(app.db), () => rank(app, viewer, query, Date.now())),
  );
  return place(kept, forgeRows, query);
}

/** The forges this forge spawned, for a site admin asking for them. */
async function forges(app: App, viewer: User | undefined, query: ExploreQuery): Promise<ExploreRow[]> {
  // A spawned forge carries no time, so a window leaves it out.
  if (query.updated !== "all" || query.owner !== undefined || viewer?.isAdmin !== true || (query.kind !== "all" && query.kind !== "forge")) return [];
  return (await listChildren(app)).map((child) => ({
    kind: "forge",
    name: child.name,
    url: child.url,
    description: child.done ? "spawned from this forge" : "being spawned",
    numbers: { forks: 0, ships: 0, likes: 0, awakeHours: 0, apps: 0 },
    shippedAt: null,
    score: 0,
  }));
}

function rank(
  app: App,
  viewer: User | undefined,
  query: ExploreQuery,
  now: number,
): ExploreRow[] {
  const db = app.db;
  const repos = listReposVisibleTo(db, viewer, {
    limit: READ,
    withoutArchived: !query.archived,
  });
  const records = appsForRepos(
    db,
    repos.map((r) => r.id),
  );
  const owners = getUsersByIds(db, [...new Set(repos.map((r) => r.ownerId))]);
  const appRepos = repos.filter(
    (r) => {
      const owner = owners.get(r.ownerId);
      // An agent's working fork is not a find; a suspended or removed
      // account's apps are not offered to anyone.
      return (
        records.has(r.id) &&
        owner !== undefined &&
        owner.kind !== "agent" &&
        isActive(owner)
      );
    },
  );
  const weights = frontWeights(db);
  const signals = frontSignals(
    db,
    appRepos.map((r) => r.id),
    now,
  );
  const told = (repo: Repo): FrontSignals => {
    const s = signals.get(repo.id) ?? {
      awakeHours: 0,
      ships: 0,
      forks: 0,
      shippedAt: null,
    };
    const record = records.get(repo.id)!;
    return canEnterApp(db, repo, record, viewer)
      ? s
      : { ...s, awakeHours: 0 };
  };

  const likes = likesByRepo(db, appRepos.map((r) => r.id));

  const copyable = (repo: Repo): boolean => {
    // A signed-out visitor is offered only public apps; the page they land on
    // sends them to sign in first, and the copy is made after.
    if (viewer === undefined) return records.get(repo.id)!.access === "public";
    if (viewer.kind === "agent" || !isActive(viewer)) return false;
    if (repo.ownerId === viewer.id) return false;
    const record = records.get(repo.id)!;
    return (
      record.access === "public" ||
      canEnterApp(db, repo, record, viewer, { named: false })
    );
  };
  const appRows: ExploreRow[] = appRepos.map((repo) => {
    const s = told(repo);
    const liked = likes.get(repo.id) ?? 0;
    return {
      kind: "app",
      name: `${repo.ownerName}/${repo.name}`,
      url: `/${repo.ownerName}/${repo.name}`,
      description: repo.description,
      numbers: {
        forks: s.forks,
        ships: s.ships,
        likes: liked,
        awakeHours: Math.round(s.awakeHours * 10) / 10,
        apps: 1,
      },
      shippedAt: s.shippedAt,
      score: frontScore(s, now, weights) + LIKE_WEIGHT * Math.log1p(liked),
      repo: { owner: repo.ownerName, name: repo.name },
      copyable: copyable(repo),
    };
  });

  const people = new Map<string, ExploreRow>();
  appRepos.forEach((repo, at) => {
    const row = appRows[at]!;
    const was = people.get(repo.ownerName);
    const latest = [was?.shippedAt ?? null, row.shippedAt]
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1);
    const owner = owners.get(repo.ownerId);
    const mark = markOf(owner);
    people.set(repo.ownerName, {
      kind: "person",
      name: repo.ownerName,
      url: `/${repo.ownerName}`,
      description: owner?.displayName ?? "",
      ...(mark === undefined ? {} : { mark }),
      numbers: {
        forks: (was?.numbers.forks ?? 0) + row.numbers.forks,
        ships: (was?.numbers.ships ?? 0) + row.numbers.ships,
        likes: (was?.numbers.likes ?? 0) + row.numbers.likes,
        awakeHours:
          Math.round(((was?.numbers.awakeHours ?? 0) + row.numbers.awakeHours) * 10) / 10,
        apps: (was?.numbers.apps ?? 0) + 1,
      },
      shippedAt: latest ?? null,
      // A person ranks by their best app, so one with many small ones
      // does not crowd out everything else.
      score: Math.max(was?.score ?? 0, row.score),
    });
  });

  const text = query.text.toLowerCase();
  const only = query.owner?.toLowerCase();
  // Kept rows are shared by every request that reads them: none may change.
  const freeze = (row: ExploreRow): ExploreRow => {
    Object.freeze(row.numbers);
    return Object.freeze(row);
  };
  return order(
    [...appRows, ...people.values()].map(freeze).filter(
      (row) =>
        (query.kind === "all" || row.kind === query.kind) &&
        movedWithin(row, query, now) &&
        (only === undefined || (row.repo?.owner ?? row.name).toLowerCase() === only) &&
        (text === "" || `${row.name} ${row.description}`.toLowerCase().includes(text)),
    ),
    query,
  );
}

/** What a like adds to the score sort: modest next to forks (3) and ships (2). */
const LIKE_WEIGHT = 0.5;

/** Likes on posts about each repository; the caller passes only repositories the viewer may read. */
function likesByRepo(db: Database, repoIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (repoIds.length === 0) return out;
  const rows = db
    .query<{ repo_id: string; n: number }, [string]>(
      `SELECT repo_id, COUNT(*) AS n FROM feed_like
        WHERE repo_id IN (SELECT value FROM json_each(?1)) GROUP BY repo_id`,
    )
    .all(JSON.stringify(repoIds));
  for (const r of rows) out.set(r.repo_id, r.n);
  return out;
}

function sortKey(r: ExploreRow, sort: ExploreSort): number | string {
  switch (sort) {
    case "score": return r.score;
    case "forks": return r.numbers.forks;
    case "ships": return r.numbers.ships;
    case "likes": return r.numbers.likes;
    case "use": return r.numbers.awakeHours;
    case "fresh": return r.shippedAt === null ? 0 : Date.parse(r.shippedAt) || 0;
    case "name": return r.name.toLowerCase();
  }
}

/**
 * The total order: the sort value, then kind and name, so no two rows tie and
 * a cursor names exactly one place in it.
 */
function compare(a: Place | ExploreRow, b: Place | ExploreRow, query: ExploreQuery): number {
  const x = "key" in a ? a.key : sortKey(a, query.sort);
  const y = "key" in b ? b.key : sortKey(b, query.sort);
  const by =
    query.sort === "name"
      ? String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
      : (y as number) - (x as number);
  if (by !== 0) return by;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Whether the row's `shippedAt` (its last merged pull) is inside the window. */
function movedWithin(row: ExploreRow, query: ExploreQuery, now: number): boolean {
  if (query.updated === "all") return true;
  if (row.shippedAt === null) return false;
  const at = Date.parse(row.shippedAt);
  return now - at <= WINDOWS[query.updated]!;
}

/** Rows sorted as the query says, in place. */
function order(rows: ExploreRow[], query: ExploreQuery): ExploreRow[] {
  return rows.sort((a, b) => compare(a, b, query));
}

/**
 * The answer: the ranked rows (kept, so never changed here) with the forge
 * rows among them, whole (the callers cut a page). Only the forge rows lack a write clock,
 * so they are added after the kept read, to a copy.
 */
function place(ranked: readonly ExploreRow[], forgeRows: ExploreRow[], query: ExploreQuery): readonly ExploreRow[] {
  const text = query.text.toLowerCase();
  const own = forgeRows.filter(
    (row) => text === "" || `${row.name} ${row.description}`.toLowerCase().includes(text),
  );
  if (own.length === 0) return ranked;
  return order([...ranked, ...own], query);
}
