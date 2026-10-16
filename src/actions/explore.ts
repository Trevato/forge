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

import type { App } from "../app.ts";
import { appsForRepos } from "../core/apps.ts";
import { markOf, type Mark } from "../core/marks.ts";
import {
  frontScore,
  frontSignals,
  frontWeights,
  type FrontSignals,
} from "../core/front.ts";
import { canEnterApp, listReposVisibleTo, type Repo } from "../core/repos.ts";
import { getUsersByIds, isActive, type User } from "../core/users.ts";
import { listChildren } from "./spawn.ts";

export type ExploreKind = "app" | "person" | "forge";
export type ExploreSort =
  | "score"
  | "forks"
  | "ships"
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
}

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
  "use",
  "fresh",
  "name",
];

/** How many repositories are read, and rows answered. */
const READ = 400;
const ROWS = 60;

/**
 * The one line: `kind:` and `sort:` take a word each; anything else is
 * text to match. An unknown kind or sort is ignored, not an error — the
 * line is typed by a person.
 */
export function parseExploreQuery(line: string): ExploreQuery {
  let kind: ExploreKind | "all" = "all";
  let sort: ExploreSort = "score";
  let archived = false;
  const words: string[] = [];
  for (const word of line
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")) {
    const [key, value = ""] = word.split(/:(.*)/s);
    const k = (key ?? "").toLowerCase();
    if (k === "kind" && value !== "") kind = KINDS[value.toLowerCase()] ?? kind;
    else if (
      k === "sort" &&
      (SORTS as readonly string[]).includes(value.toLowerCase())
    )
      sort = value.toLowerCase() as ExploreSort;
    else if (k === "archived" && ["yes", "no"].includes(value.toLowerCase()))
      archived = value.toLowerCase() === "yes";
    else if (k === "q" && value !== "") words.push(value);
    else words.push(word);
  }
  return { kind, sort, text: words.join(" ").slice(0, 100), archived };
}

/** The line a query reads as, for links and the query box. */
export function exploreLine(query: ExploreQuery): string {
  return [
    query.kind === "all" ? "" : `kind:${query.kind}`,
    query.sort === "score" ? "" : `sort:${query.sort}`,
    query.archived ? "archived:yes" : "",
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

export async function explore(
  app: App,
  viewer: User | undefined,
  query: ExploreQuery,
  now = Date.now(),
): Promise<ExploreRow[]> {
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

  const copyable = (repo: Repo): boolean => {
    if (viewer === undefined || viewer.kind === "agent" || !isActive(viewer)) return false;
    if (repo.ownerId === viewer.id) return false;
    const record = records.get(repo.id)!;
    return (
      record.access === "public" ||
      canEnterApp(db, repo, record, viewer, { named: false })
    );
  };
  const appRows: ExploreRow[] = appRepos.map((repo) => {
    const s = told(repo);
    return {
      kind: "app",
      name: `${repo.ownerName}/${repo.name}`,
      url: `/${repo.ownerName}/${repo.name}`,
      description: repo.description,
      numbers: {
        forks: s.forks,
        ships: s.ships,
        awakeHours: Math.round(s.awakeHours * 10) / 10,
        apps: 1,
      },
      shippedAt: s.shippedAt,
      score: frontScore(s, now, weights),
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

  const forgeRows: ExploreRow[] =
    viewer?.isAdmin === true && (query.kind === "all" || query.kind === "forge")
      ? (await listChildren(app)).map((child) => ({
          kind: "forge",
          name: child.name,
          url: child.url,
          description: child.done ? "spawned from this forge" : "being spawned",
          numbers: { forks: 0, ships: 0, awakeHours: 0, apps: 0 },
          shippedAt: null,
          score: 0,
        }))
      : [];

  const text = query.text.toLowerCase();
  const rows = [...appRows, ...people.values(), ...forgeRows].filter(
    (row) =>
      (query.kind === "all" || row.kind === query.kind) &&
      (text === "" ||
        `${row.name} ${row.description}`.toLowerCase().includes(text)),
  );
  const by: Record<ExploreSort, (r: ExploreRow) => number | string> = {
    score: (r) => r.score,
    forks: (r) => r.numbers.forks,
    ships: (r) => r.numbers.ships,
    use: (r) => r.numbers.awakeHours,
    fresh: (r) => (r.shippedAt === null ? 0 : Date.parse(r.shippedAt)),
    name: (r) => r.name.toLowerCase(),
  };
  const key = by[query.sort];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (query.sort === "name") return String(x).localeCompare(String(y));
    return (y as number) - (x as number) || a.name.localeCompare(b.name);
  });
  return rows.slice(0, ROWS);
}
