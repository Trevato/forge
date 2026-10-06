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
 * of the truth. Nothing here caches, so nothing here can go stale — and
 * there is no derived table to rebuild when git and the index disagree.
 *
 * **Visibility is the same visibility.** Local rows come through the same
 * `VISIBLE` predicate a repo listing uses, and code is grepped only in repos
 * that predicate returned. A private repo is not filtered out of the results
 * — it never enters them.
 */

import type { Database } from "bun:sqlite";
import { runGitCapture } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { likeEscape } from "./issues.ts";
import { listReposVisibleTo, type Repo } from "./repos.ts";
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
/** Longest line of code echoed back; the rest is off-screen anyway. */
const MAX_LINE_CHARS = 400;

export type SearchKind = "repos" | "issues" | "code" | "all";

export function searchKind(raw: string | null): SearchKind {
  return raw === "repos" || raw === "issues" || raw === "code" ? raw : "all";
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
      readonly openIssues: number;
      readonly openPulls: number;
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
  const repos = listReposVisibleTo(db, viewer, { query, limit });
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
  return repos.slice(0, limit).map(toRepoHit);
}

function toRepoHit(repo: Repo): RepoHit {
  return {
    source: "local",
    id: repo.id,
    owner: repo.ownerName,
    name: repo.name,
    description: repo.description,
    visibility: repo.visibility,
    openIssues: repo.counts?.openIssues ?? 0,
    openPulls: repo.counts?.openPulls ?? 0,
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
): IssueHit[] {
  if (repos.length === 0) return [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const ids = [...byId.keys()];
  const holes = ids.map((_, i) => `?${i + 1}`).join(",");
  const open = [...sealedOk].filter((id) => byId.has(id));
  const sealedClause =
    open.length === 0
      ? "AND sealed = 0"
      : `AND (sealed = 0 OR repo_id IN (${open.map((_, i) => `?${ids.length + 3 + i}`).join(",")}))`;
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
    .all(...ids, `%${likeEscape(query.trim())}%`, limit, ...open);

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
    { cwd: dir, timeoutMs: GREP_TIMEOUT_MS },
  );
  // Exit 1 is "no match" — data, not failure. Anything else (a repo with no
  // commits, a killed process) is simply no results from this repo.
  if (run.code !== 0 && run.code !== 1) return [];

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

/**
 * Grep across a bounded set of repos. Repos are searched a few at a time so
 * fifty small greps do not become fifty simultaneous processes, and the walk
 * stops the moment the cap is reached — a common word in a monorepo costs
 * one repo's work, not fifty.
 */
export async function grepRepos(
  reposRoot: string,
  repos: readonly Repo[],
  query: string,
  limit = MAX_CODE_HITS,
): Promise<{ hits: CodeHit[]; truncated: boolean }> {
  const hits: CodeHit[] = [];
  const considered = repos.slice(0, MAX_SEARCH_REPOS);
  const batch = 4;
  for (let i = 0; i < considered.length; i += batch) {
    const slice = considered.slice(i, i + batch);
    const found = await Promise.all(
      slice.map((repo) =>
        grepRepo(
          repoDir(reposRoot, repo.ownerName, repo.name),
          repo.defaultBranch,
          query,
        ),
      ),
    );
    for (const [j, repo] of slice.entries()) {
      for (const hit of found[j] ?? []) {
        if (hits.length >= limit) return { hits, truncated: true };
        hits.push({
          repo: { owner: repo.ownerName, name: repo.name },
          ...hit,
        });
      }
    }
  }
  return { hits, truncated: repos.length > MAX_SEARCH_REPOS };
}
