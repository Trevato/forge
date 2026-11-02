/**
 * One search over everything a person can reach: local repos, the cached
 * repos of every origin they have connected, local issues and pulls, and the
 * code itself.
 *
 * Three rules shape it.
 *
 * **Bounded, always.** Every list has a ceiling and every subprocess a
 * deadline, so a one-character query costs the same order of work as a
 * precise one. "Soon tons of agents" means the palette is a hot path, not a
 * thing a person types once a day.
 *
 * **No index of its own.** Repos and issues are already indexed rows; code
 * is answered by `git grep` against the object store, which is the only copy
 * of the truth. The one memory is a bounded cache of a repo's grep answer
 * keyed by (repo id, commit oid, query): a commit never changes, so the
 * entry cannot go stale, and a new commit is a new key. It sits below
 * visibility — it is asked only for repos the viewer already may see.
 *
 * **Visibility is the same visibility.** Local rows come through the same
 * `VISIBLE` predicate a repo listing uses, and code is grepped only in repos
 * that predicate returned. A private repo is not filtered out of the results
 * — it never enters them.
 */

import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGitCapture } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { GREP_LIMITS, grepSlots, type GrepSlots } from "../search/grep_slots.ts";
import { appsForRepos } from "./apps.ts";
import { likeEscape } from "./issues.ts";
import { enterableApps, listReposVisibleTo, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** The longest query we will run. Longer is a paste, not a search. */
export const MAX_QUERY = 200;
/** Repos considered for one query (and, for code, grepped). */
export const MAX_SEARCH_REPOS = 50;
/** Total code hits returned, across every repo. */
export const MAX_CODE_HITS = 200;
/** Code hits taken from any one repo, so a vendor tree cannot fill the page. */
export const MAX_HITS_PER_REPO = 20;
/** A grep that has not answered in this long is abandoned, not waited on. */
export const GREP_TIMEOUT_MS = 3_000;
/** A first code search starts no new grep after this long; `?code=all` runs the rest. */
export const CODE_BUDGET_MS = 30;
/** A grep in a budgeted search is given up after this long and reported as `more`: a cold clone must not hold the page (#7198). */
export const BUDGETED_GREP_MS = 400;

/** Longest line of code echoed back; the rest is off-screen anyway. */
const MAX_LINE_CHARS = 400;

export type SearchKind = "repos" | "issues" | "code" | "all";

export function searchKind(raw: string | null): SearchKind {
  return raw === "repos" || raw === "issues" || raw === "code" ? raw : "all";
}

/**
 * What a caller who asked wrongly is told, in one sentence, or undefined when
 * the request was fine (an unknown kind or limit is `searchRefusal`'s 422, not a note). Plain text: the caller escapes it where it draws it.
 */
export function searchNote(rawQ: string | null): string | undefined {
  if (cleanQuery(rawQ ?? "") === "")
    return "q is empty — send what to find, e.g. q=parser&kind=code (kind=all|repos|issues|code)";
  return undefined;
}

/** A repo here, or one cached from an origin the actor has connected. */
export type RepoHit =
  | {
      readonly source: "local";
      readonly id: string;
      readonly owner: string;
      readonly name: string;
      readonly description: string;
      readonly visibility: "public" | "private";
      /** Put away by an admin: still found, but not live. */
      readonly archived: boolean;
      readonly openIssues: number;
      readonly openPulls: number;
      /** The repository runs an app. */
      readonly app: boolean;
    }
  | {
      readonly source: "origin";
      readonly originId: string;
      readonly originKind: string;
      readonly fullName: string;
      readonly description: string;
      readonly private: boolean;
      readonly htmlUrl: string;
      /** The local mirror of this repo, when one exists. */
      readonly mirroredAs: { owner: string; name: string } | null;
      readonly openIssues: number;
      readonly openPulls: number;
      /** True when `openIssues` is the origin's issues-and-pulls total. */
      readonly openIssuesIncludingPulls: boolean;
    };

/** A conversation here, or one the origin's own search turned up. */
export type IssueHit =
  | {
      readonly source: "local";
      readonly repo: { owner: string; name: string };
      readonly number: number;
      readonly kind: "issue" | "pull";
      readonly title: string;
      readonly state: "open" | "closed";
      readonly updatedAt: string;
    }
  | {
      readonly source: "origin";
      readonly originId: string;
      readonly fullName: string;
      readonly number: number;
      readonly kind: "issue" | "pull";
      readonly title: string;
      readonly state: "open" | "closed";
      readonly updatedAt: string;
      readonly htmlUrl: string;
    };

export interface CodeHit {
  readonly repo: { owner: string; name: string };
  /** The repository is archived. */
  readonly archived: boolean;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchResults {
  readonly repos: readonly RepoHit[];
  readonly issues: readonly IssueHit[];
  readonly code: readonly CodeHit[];
  /** Which lists hit their ceiling — a client can say "and more". */
  readonly truncated: {
    readonly repos: boolean;
    readonly issues: boolean;
    readonly code: boolean;
  };
  /** True when the code budget ran out with repositories still ungrepped. */
  readonly moreCode: boolean;
  /** True when a grep was refused a slot (`search/grep_slots.ts`): code results are partial. */
  readonly codeSkipped: boolean;
}

/**
 * A query we are willing to run: control bytes flattened (they can only
 * confuse a NUL-delimited or line-delimited protocol downstream), trimmed,
 * and bounded.
 */
export function cleanQuery(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_QUERY);
}

// ---- repos ----

/** Local repos whose name, owner or description matches, newest first. */
export function searchLocalRepos(
  db: Database,
  viewer: User | undefined,
  query: string,
  limit: number,
): RepoHit[] {
  // A wide page, then ranked: with many forks of similar names the newest
  // `limit` would cut the repository whose name was typed.
  const repos = rankByName(
    listReposVisibleTo(db, viewer, { query, limit: 100 }),
    viewer,
    query,
  );
  // `listReposVisibleTo` matches owner and name; description is the extra
  // reach a search box wants, so it is unioned in rather than replacing it.
  const byDescription = describedRepos(db, viewer, query, limit);
  const seen = new Set(repos.map((r) => r.id));
  for (const repo of byDescription) {
    if (repos.length >= limit) break;
    if (seen.has(repo.id)) continue;
    seen.add(repo.id);
    repos.push(repo);
  }
  const page = repos.slice(0, limit);
  // A private app is the writers' to know of; to anyone else the row is plain.
  const apps = appsForRepos(
    db,
    page.map((r) => r.id),
  );
  const enterable = enterableApps(
    db,
    page.flatMap((repo) => {
      const app = apps.get(repo.id);
      return app === undefined ? [] : [{ repo, app }];
    }),
    viewer,
    { named: false },
  );
  return page.map((r) => {
    const app = apps.get(r.id);
    return toRepoHit(r, app !== undefined && enterable.has(app.id));
  });
}

/**
 * Exact name first, then names that begin with what was typed, then the
 * rest; within a tier the viewer's own repositories lead. Stable, so the
 * listing's newest-first order decides among equals.
 */
function rankByName(
  repos: Repo[],
  viewer: User | undefined,
  query: string,
): Repo[] {
  const q = query.trim().toLowerCase();
  const tier = (r: Repo): number => {
    const name = r.name.toLowerCase();
    const exact = name === q || `${r.ownerName}/${name}`.toLowerCase() === q;
    const t = exact ? 0 : name.startsWith(q) ? 1 : 2;
    return t * 2 + (viewer !== undefined && r.ownerId === viewer.id ? 0 : 1);
  };
  return repos
    .map((r, i) => ({ r, i, t: tier(r) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.r);
}

/** The one repository a scoped search is about, when its owner, name or description holds the words. */
export function matchOneRepo(repo: Repo, query: string, app: boolean): RepoHit[] {
  const needle = query.trim().toLowerCase();
  const hay = `${repo.ownerName}/${repo.name} ${repo.description}`.toLowerCase();
  return needle !== "" && hay.includes(needle) ? [toRepoHit(repo, app)] : [];
}

function toRepoHit(repo: Repo, app: boolean): RepoHit {
  return {
    source: "local",
    id: repo.id,
    owner: repo.ownerName,
    name: repo.name,
    description: repo.description,
    visibility: repo.visibility,
    archived: repo.archivedAt !== null,
    openIssues: repo.counts?.openIssues ?? 0,
    openPulls: repo.counts?.openPulls ?? 0,
    app,
  };
}

/**
 * The description half of a repo search. It reuses the listing's own
 * visibility rule by asking for a page and filtering it, rather than
 * restating the predicate — one copy of "who may see what" is the point.
 */
function describedRepos(
  db: Database,
  viewer: User | undefined,
  query: string,
  limit: number,
): Repo[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return listReposVisibleTo(db, viewer, { limit: MAX_SEARCH_REPOS })
    .filter((r) => r.description.toLowerCase().includes(needle))
    .slice(0, limit);
}

interface OriginRepoHitRow {
  origin_id: string;
  origin_kind: string;
  full_name: string;
  description: string;
  private: number;
  html_url: string;
  open_issues: number;
  open_pulls: number;
  counts_include_pulls: number;
  mirror_owner: string | null;
  mirror_name: string | null;
}

/**
 * Cached repos across every origin this user has connected. The cache is
 * what the import picker already fills, so a global search sees the other
 * forges without spending one request on them.
 */
export function searchOriginRepos(
  db: Database,
  userId: string,
  query: string,
  limit: number,
): RepoHit[] {
  const like = `%${likeEscape(query.trim())}%`;
  const rows = db
    .query<OriginRepoHitRow, [string, string, number]>(
      `SELECT origin_repo.origin_id, origin.kind AS origin_kind,
              origin_repo.full_name, origin_repo.description,
              origin_repo.private, origin_repo.html_url,
              origin_repo.open_issues, origin_repo.open_pulls,
              origin_repo.counts_include_pulls,
              owner.username AS mirror_owner, repo.name AS mirror_name
       FROM origin_repo
       JOIN origin ON origin.id = origin_repo.origin_id
       LEFT JOIN repo ON repo.origin_id = origin_repo.origin_id
                     AND repo.origin_remote_id = origin_repo.remote_id
       LEFT JOIN user AS owner ON owner.id = repo.owner_id
       WHERE origin.user_id = ?1
         AND (origin_repo.full_name LIKE ?2 ESCAPE '\\' COLLATE NOCASE
           OR origin_repo.description LIKE ?2 ESCAPE '\\' COLLATE NOCASE)
       ORDER BY origin_repo.full_name COLLATE NOCASE
       LIMIT ?3`,
    )
    .all(userId, like, limit);

  return rows.map((row) => ({
    source: "origin" as const,
    originId: row.origin_id,
    originKind: row.origin_kind,
    fullName: row.full_name,
    description: row.description,
    private: row.private === 1,
    htmlUrl: row.html_url,
    mirroredAs:
      row.mirror_owner !== null && row.mirror_name !== null
        ? { owner: row.mirror_owner, name: row.mirror_name }
        : null,
    openIssues: row.open_issues,
    openPulls: row.open_pulls,
    openIssuesIncludingPulls: row.counts_include_pulls === 1,
  }));
}

// ---- issues ----

/**
 * Issues and pulls whose title matches, inside a bounded set of repos.
 *
 * `repo_id IN (...)` is not decoration: it is what lets SQLite walk the
 * `issue(repo_id, …)` indexes instead of scanning every conversation in the
 * forge, and `test/search.test.ts` asserts the plan stays that way.
 */
export function searchLocalIssues(
  db: Database,
  repos: readonly Repo[],
  query: string,
  limit: number,
  /** The repositories among these whose sealed issues the viewer may see (`sealed.ts`). */
  sealedOk: ReadonlySet<string> = new Set(),
  /** And the sealed reports this user filed, wherever they are. */
  sealedBy?: string,
): IssueHit[] {
  if (repos.length === 0) return [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const ids = [...byId.keys()];
  const holes = ids.map((_, i) => `?${i + 1}`).join(",");
  const open = [...sealedOk].filter((id) => byId.has(id));
  const extra: string[] = [...open, ...(sealedBy === undefined ? [] : [sealedBy])];
  const ors = [
    "sealed = 0",
    ...(open.length === 0
      ? []
      : [`repo_id IN (${open.map((_, i) => `?${ids.length + 3 + i}`).join(",")})`]),
    ...(sealedBy === undefined ? [] : [`author_id = ?${ids.length + 3 + open.length}`]),
  ];
  const sealedClause = `AND (${ors.join(" OR ")})`;
  const rows = db
    .query<
      {
        repo_id: string;
        number: number;
        kind: "issue" | "pull";
        title: string;
        state: "open" | "closed";
        updated_at: string;
      },
      (string | number)[]
    >(
      `SELECT repo_id, number, kind, title, state, updated_at
       FROM issue
       WHERE repo_id IN (${holes})
         AND title LIKE ?${ids.length + 1} ESCAPE '\\' COLLATE NOCASE
         ${sealedClause}
       ORDER BY updated_at DESC
       LIMIT ?${ids.length + 2}`,
    )
    .all(...ids, `%${likeEscape(query.trim())}%`, limit, ...extra);

  const hits: IssueHit[] = [];
  for (const row of rows) {
    const repo = byId.get(row.repo_id);
    if (!repo) continue;
    hits.push({
      source: "local",
      repo: { owner: repo.ownerName, name: repo.name },
      number: row.number,
      kind: row.kind,
      title: row.title,
      state: row.state,
      updatedAt: row.updated_at,
    });
  }
  return hits;
}

// ---- code ----

/**
 * `git grep` one repo at one ref.
 *
 * The argument shape is the security boundary. `-e <pattern>` is what makes
 * a query starting with `-` a pattern rather than a flag; `--` ends the
 * options so a query containing `--` cannot re-open them; `-F` makes the
 * query a fixed string, so a search box cannot hand git a pathological
 * regex; `-I` skips binaries; `--max-count` and the timeout bound the work.
 * The ref goes through `isSafeRef` like every other rev in the forge.
 */
export async function grepRepo(
  dir: string,
  ref: string,
  query: string,
  maxCount = MAX_HITS_PER_REPO,
): Promise<{ path: string; line: number; text: string }[]> {
  const got = await grepRun(dir, ref, query, maxCount);
  return got === null || got === "timeout" ? [] : got;
}

type RawHit = { path: string; line: number; text: string };

/**
 * Hits; null when the grep failed (a repo with no commits, say), and
 * "timeout" when the clock killed it. Neither is worth keeping, but only a
 * timeout means a longer run might find more.
 */
async function grepRun(
  dir: string,
  ref: string,
  query: string,
  maxCount: number,
  timeoutMs = GREP_TIMEOUT_MS,
): Promise<RawHit[] | null | "timeout"> {
  const pattern = cleanQuery(query);
  if (pattern === "" || !isSafeRef(ref)) return [];

  const run = await runGitCapture(
    [
      "grep",
      "-z",
      "-n",
      "-I",
      "-i",
      "-F",
      "--no-color",
      `--max-count=${maxCount}`,
      "-e",
      pattern,
      ref,
      "--",
      ".",
    ],
    { cwd: dir, timeoutMs },
  );
  // Exit 1 is "no match" — data, not failure. Anything else (a repo with no
  // commits, a killed process) is simply no results from this repo.
  if (run.timedOut === true) return "timeout";
  if (run.code !== 0 && run.code !== 1) return null;

  // `-z` makes each record `ref:path NUL line NUL text`, so a path with a
  // colon in it (`a:1:b.txt`) cannot be split at the wrong colon.
  const prefix = `${ref}:`;
  const hits: { path: string; line: number; text: string }[] = [];
  for (const raw of run.stdout.split("\n")) {
    if (raw === "" || !raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const match = /^([^\0]+)\0(\d+)\0([\s\S]*)$/.exec(rest);
    if (!match) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line)) continue;
    hits.push({
      path: match[1]!,
      line,
      text: (match[3] ?? "").slice(0, MAX_LINE_CHARS),
    });
    if (hits.length >= maxCount) break;
  }
  return hits;
}

const CACHE_MAX = 4_000;
const grepCache = new Map<string, RawHit[]>();

/**
 * The commit a branch points at, read from the ref files rather than a
 * subprocess. Null when it cannot be told for certain (a tag of the same
 * name, a missing ref): the caller then greps uncached.
 */
async function branchOid(dir: string, branch: string): Promise<string | null> {
  if (!isSafeRef(branch) || branch.includes("..")) return null;
  const oid = /^[0-9a-f]{40,64}$/;
  const slurp = (path: string) =>
    readFile(path, "utf8").then((t) => t, () => null);
  const packed = (await slurp(join(dir, "packed-refs"))) ?? "";
  const inPacked = (ref: string) => {
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`) && oid.test(line.slice(0, line.indexOf(" "))))
        return line.slice(0, line.indexOf(" "));
    }
    return null;
  };
  if (inPacked(`refs/tags/${branch}`) !== null) return null;
  if ((await slurp(join(dir, "refs", "tags", branch))) !== null) return null;
  const loose = (await slurp(join(dir, "refs", "heads", branch)))?.trim();
  if (loose !== undefined) return loose !== null && oid.test(loose) ? loose : null;
  return inPacked(`refs/heads/${branch}`);
}

/** Greps actually run — a test reads it to prove a repeat ran none. */
let grepsRun = 0;
export const grepCount = (): number => grepsRun;

/**
 * Cached by the commit the branch points at, and grepped at that commit, so
 * the key and the content cannot disagree if a push lands in between. The
 * branch's oid comes from the ref files, not from asking git, so a search of
 * fifty repos spawns nothing when it is answered from memory. Whenever the
 * name could mean something else to git (a tag of the same name) `branchOid`
 * gives up and the repo is grepped by name, which is git's own resolution.
 */
async function grepCached(
  repo: Repo,
  dir: string,
  query: string,
  who: GrepWho,
  timeoutMs = GREP_TIMEOUT_MS,
): Promise<RawHit[] | "skipped" | "timeout"> {
  const ref = repo.defaultBranch;
  const oid = await branchOid(dir, ref);
  const slotted = async (at: string): Promise<RawHit[] | null | "skipped" | "timeout"> => {
    const got = await (who.slots ?? grepSlots).run(who.memberId, () => {
      grepsRun++;
      return (who.grep ?? grepRun)(dir, at, query, MAX_HITS_PER_REPO, timeoutMs);
    });
    return got.ran ? got.value : "skipped";
  };
  if (oid === null) {
    const hits = await slotted(ref);
    return hits ?? [];
  }
  const key = `${repo.id}\0${oid}\0${cleanQuery(query)}`;
  const kept = grepCache.get(key);
  if (kept !== undefined) {
    grepCache.delete(key);
    grepCache.set(key, kept);
    return kept.map((h) => ({ ...h }));
  }
  const hits = await slotted(oid);
  if (hits === "skipped" || hits === "timeout") return hits;
  if (hits === null) return [];
  grepCache.set(key, hits.map((h) => ({ ...h })));
  if (grepCache.size > CACHE_MAX) {
    grepCache.delete(grepCache.keys().next().value as string);
  }
  return hits;
}

/** Whose slot a grep takes; `grep`, `slots`, `now` and `timer` are for tests to inject. */
export interface GrepWho {
  /** The signed-in actor's id; undefined is a stranger. */
  readonly memberId?: string | undefined;
  readonly slots?: GrepSlots;
  readonly grep?: typeof grepRun;
  /** Milliseconds on a monotonic clock; `performance.now` by default. */
  readonly now?: () => number;
  /** Resolves after `ms`; `clear` stops it. A `setTimeout` by default. */
  readonly timer?: (ms: number) => BudgetTimer;
}

export interface BudgetTimer {
  readonly done: Promise<void>;
  clear(): void;
}

function budgetTimer(ms: number): BudgetTimer {
  let id: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return { done, clear: () => clearTimeout(id) };
}

/**
 * Grep across a bounded set of repos. Repos are searched a few at a time so
 * fifty small greps do not become fifty simultaneous processes, and the walk
 * stops the moment the cap is reached — a common word in a monorepo costs
 * one repo's work, not fifty.
 *
 * With a finite budget the first batch is always waited for, so a cold search
 * shows what it finds however slow git is. Each later batch races the time
 * left: when the budget runs out first the answer goes back with `more`, and
 * the batch's greps are left to finish on their own. They keep the slot
 * `search/grep_slots.ts` gave them until git exits — that is the only cap on
 * abandoned greps, and it is charged to the caller who started them.
 */
export async function grepRepos(
  reposRoot: string,
  repos: readonly Repo[],
  query: string,
  limit = MAX_CODE_HITS,
  /** No new batch starts after this many ms, nor is waited on past it; the rest is `more`. */
  budgetMs = Infinity,
  who: GrepWho = {},
): Promise<{ hits: CodeHit[]; truncated: boolean; more: boolean; skipped: boolean }> {
  let skipped = false;
  const hits: CodeHit[] = [];
  const considered = repos.slice(0, MAX_SEARCH_REPOS);
  const batch = 4;
  // Within a batch a member's greps run in pairs, so a search never
  // starves itself of the member's own slots.
  const width = who.memberId === undefined ? batch : GREP_LIMITS.perMember;
  const now = who.now ?? (() => performance.now());
  const started = now();
  const timeoutMs = budgetMs === Infinity ? GREP_TIMEOUT_MS : BUDGETED_GREP_MS;
  let gaveUp = false;
  // Set when this search answers at its budget: the batch it left behind
  // starts no further pair. Local to this call, never shared between callers.
  let answered = false;
  const more = () => {
    answered = true;
    return { hits, truncated: repos.length > MAX_SEARCH_REPOS, more: true, skipped };
  };
  const grepBatch = async (slice: readonly Repo[]) => {
    const found: (RawHit[] | "skipped" | "timeout")[] = [];
    for (let k = 0; k < slice.length && !answered; k += width) {
      found.push(
        ...(await Promise.all(
          slice
            .slice(k, k + width)
            .map((repo) =>
              grepCached(
                repo,
                repoDir(reposRoot, repo.ownerName, repo.name),
                query,
                who,
                timeoutMs,
              ),
            ),
        )),
      );
    }
    return found;
  };
  for (let i = 0; i < considered.length; i += batch) {
    const slice = considered.slice(i, i + batch);
    let found: (RawHit[] | "skipped" | "timeout")[];
    if (i === 0 || budgetMs === Infinity) {
      found = await grepBatch(slice);
    } else {
      const left = budgetMs - (now() - started);
      if (left <= 0) return more();
      const running = grepBatch(slice);
      // An abandoned batch settles on its own; a rejection then is nobody's.
      running.catch(() => {});
      const timer = (who.timer ?? budgetTimer)(left);
      const raced = await Promise.race([running, timer.done.then(() => "cut" as const)]);
      timer.clear();
      if (raced === "cut") return more();
      found = raced;
    }
    for (const [j, repo] of slice.entries()) {
      const mine = found[j] ?? [];
      if (mine === "skipped") {
        skipped = true;
        continue;
      }
      if (mine === "timeout") {
        if (timeoutMs !== GREP_TIMEOUT_MS) gaveUp = true;
        continue;
      }
      for (const hit of mine) {
        if (hits.length >= limit) return { hits, truncated: true, more: false, skipped };
        hits.push({
          repo: { owner: repo.ownerName, name: repo.name },
          archived: repo.archivedAt !== null,
          ...hit,
        });
      }
    }
  }
  return { hits, truncated: repos.length > MAX_SEARCH_REPOS, more: gaveUp, skipped };
}
