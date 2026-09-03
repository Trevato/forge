/**
 * Repositories: a row in the index and a bare repo on disk. Ordering
 * invariant, paid for elsewhere: the git directory becomes durable BEFORE
 * the row that references it, so a visible row always means a clonable
 * repo. Deletion inverts the order — row first, directory second.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { installHooks } from "../git/hooks.ts";
import {
  deleteRepoDir,
  detachFork,
  forkBareRepo,
  initBareRepo,
  repoDir,
} from "../git/repos.ts";
import { id } from "../kernel/id.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { likeEscape, pageLimit } from "./issues.ts";
import { accessAllows, orgAccess, type Access } from "./orgs.ts";
import { getUserById, type User } from "./users.ts";

const log = createLog("repos");

/**
 * Where a mirrored repo came from. Present only while the origin is still
 * connected: disconnecting sets `repo.origin_id` to NULL, and the repo goes
 * on being readable as an ordinary local one that simply stopped syncing.
 */
export interface RepoOrigin {
  readonly originId: string;
  readonly kind: "github" | "forgejo" | "gitea";
  /** `owner/name` on the origin. */
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly lastFetchAt: string | null;
  /** The last fetch's failure, or empty when healthy. */
  readonly fetchError: string;
}

/**
 * What a repo list wants beside every row. Both numbers are open counts —
 * a closed conversation is history, not a queue.
 */
export interface RepoCounts {
  readonly openIssues: number;
  readonly openPulls: number;
}

export interface Repo {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly defaultBranch: string;
  readonly protectDefault: boolean;
  /** The repo this was forked from, or null. */
  readonly forkParentId: string | null;
  /** The origin this mirrors, or null for a native repo. */
  readonly origin: RepoOrigin | null;
  /**
   * Open issue and pull counts. Absent from a bare `getRepo` — a single
   * fetch on a hot path should not pay for a count nobody asked for — and
   * always present on a list, filled by `countsForRepos` in one query.
   */
  readonly counts?: RepoCounts;
}

interface RepoRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  visibility: "public" | "private";
  description: string;
  default_branch: string;
  protect_default: number;
  fork_parent_id: string | null;
  origin_id: string | null;
  origin_kind: "github" | "forgejo" | "gitea" | null;
  origin_full_name: string | null;
  origin_html_url: string | null;
  last_fetch_at: string | null;
  fetch_error: string;
}

// LEFT JOIN, because the origin may have been disconnected out from under a
// mirror — the repo survives, the link does not.
const SELECT = `
  SELECT repo.*, user.username AS owner_name, origin.kind AS origin_kind
  FROM repo JOIN user ON user.id = repo.owner_id
  LEFT JOIN origin ON origin.id = repo.origin_id`;

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    name: row.name,
    visibility: row.visibility,
    description: row.description,
    defaultBranch: row.default_branch,
    protectDefault: row.protect_default === 1,
    forkParentId: row.fork_parent_id,
    origin:
      row.origin_id !== null && row.origin_kind !== null
        ? {
            originId: row.origin_id,
            kind: row.origin_kind,
            fullName: row.origin_full_name ?? "",
            htmlUrl: row.origin_html_url ?? "",
            lastFetchAt: row.last_fetch_at,
            fetchError: row.fetch_error,
          }
        : null,
  };
}

const NO_COUNTS: RepoCounts = { openIssues: 0, openPulls: 0 };

/** How many ids one `IN (...)` carries; the rest come in further rounds. */
const COUNT_CHUNK = 500;

/**
 * Open issue and pull counts for many repos, in one grouped query per chunk
 * — never one query per row. A repo list is the place N+1 hurts most (the
 * dashboard asks for fifty repos at once), so the grouped shape is the only
 * shape offered: there is deliberately no `countsForRepo` singular.
 */
export function countsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, RepoCounts> {
  const counts = new Map<string, RepoCounts>();
  for (const id of repoIds) counts.set(id, NO_COUNTS);
  for (let i = 0; i < repoIds.length; i += COUNT_CHUNK) {
    const chunk = repoIds.slice(i, i + COUNT_CHUNK);
    if (chunk.length === 0) continue;
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    const rows = db
      .query<{ repo_id: string; kind: "issue" | "pull"; n: number }, string[]>(
        `SELECT repo_id, kind, COUNT(*) AS n FROM issue
         WHERE state = 'open' AND repo_id IN (${holes})
         GROUP BY repo_id, kind`,
      )
      .all(...chunk);
    for (const row of rows) {
      const current = counts.get(row.repo_id) ?? NO_COUNTS;
      counts.set(
        row.repo_id,
        row.kind === "pull"
          ? { ...current, openPulls: row.n }
          : { ...current, openIssues: row.n },
      );
    }
  }
  return counts;
}

/** Attach counts to a page of repos with one extra query for the page. */
export function withCounts(db: Database, repos: Repo[]): Repo[] {
  if (repos.length === 0) return repos;
  const counts = countsForRepos(
    db,
    repos.map((r) => r.id),
  );
  return repos.map((repo) => ({
    ...repo,
    counts: counts.get(repo.id) ?? NO_COUNTS,
  }));
}

export type CreateRepoError = "invalid_name" | "name_taken" | "git_init_failed";

export interface CreateRepoInput {
  ownerId: string;
  name: string;
  /** @default "private" */
  visibility?: "public" | "private";
  /** @default "" */
  description?: string;
  /** @default "main" */
  defaultBranch?: string;
}

export async function createRepo(
  db: Database,
  reposRoot: string,
  input: CreateRepoInput,
): Promise<Result<Repo, CreateRepoError>> {
  if (!isSafeName(input.name)) return err("invalid_name");
  const owner = db
    .query<
      { username: string },
      [string]
    >("SELECT username FROM user WHERE id = ?1")
    .get(input.ownerId);
  if (!owner) return err("invalid_name");

  const taken = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE")
    .get(input.ownerId, input.name);
  if (taken) return err("name_taken");

  // Git first, row second: a row that exists is a repo you can clone.
  const dir = repoDir(reposRoot, owner.username, input.name);
  const branch = input.defaultBranch ?? "main";
  const init = await initBareRepo(dir, { defaultBranch: branch });
  if (!init.ok) return err("git_init_failed");
  await installHooks(dir);

  const repoId = id();
  db.query(
    `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    repoId,
    input.ownerId,
    input.name,
    input.visibility ?? "private",
    input.description ?? "",
    branch,
  );
  return ok(getRepoById(db, repoId)!);
}

export type ForkRepoError =
  | "invalid_name"
  | "name_taken"
  | "already_forked"
  | "fork_failed";

/**
 * Fork a repo into another owner. The git objects are shared with the parent
 * via alternates (see forkBareRepo), so this is instant and storage-bounded.
 * The fork inherits the parent's visibility and default branch.
 */
export async function forkRepo(
  db: Database,
  reposRoot: string,
  parent: Repo,
  ownerId: string,
  name?: string,
): Promise<Result<Repo, ForkRepoError>> {
  const forkName = name ?? parent.name;
  if (!isSafeName(forkName)) return err("invalid_name");
  const owner = db
    .query<
      { username: string },
      [string]
    >("SELECT username FROM user WHERE id = ?1")
    .get(ownerId);
  if (!owner) return err("invalid_name");

  // One fork of a given parent per owner keeps the graph simple; this check
  // comes first so a re-fork reports "already_forked", not "name_taken".
  if (
    db
      .query("SELECT 1 FROM repo WHERE owner_id = ?1 AND fork_parent_id = ?2")
      .get(ownerId, parent.id)
  ) {
    return err("already_forked");
  }
  if (
    db
      .query(
        "SELECT 1 FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(ownerId, forkName)
  ) {
    return err("name_taken");
  }

  const parentDir = repoDir(reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(reposRoot, owner.username, forkName);
  const forked = await forkBareRepo(parentDir, forkDir);
  if (!forked.ok) return err("fork_failed");
  await installHooks(forkDir);

  const repoId = id();
  db.query(
    `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch, fork_parent_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    repoId,
    ownerId,
    forkName,
    parent.visibility,
    parent.description,
    parent.defaultBranch,
    parent.id,
  );
  return ok(getRepoById(db, repoId)!);
}

/** Repos forked directly from this one. */
export function listForks(db: Database, repoId: string): Repo[] {
  return db
    .query<
      RepoRow,
      [string]
    >(`${SELECT} WHERE repo.fork_parent_id = ?1 ORDER BY repo.id`)
    .all(repoId)
    .map(toRepo);
}

export function getRepo(
  db: Database,
  ownerName: string,
  name: string,
): Repo | undefined {
  const row = db
    .query<
      RepoRow,
      [string, string]
    >(`${SELECT} WHERE user.username = ?1 COLLATE NOCASE AND repo.name = ?2 COLLATE NOCASE`)
    .get(ownerName, name);
  return row ? toRepo(row) : undefined;
}

export function getRepoById(db: Database, repoId: string): Repo | undefined {
  const row = db
    .query<RepoRow, [string]>(`${SELECT} WHERE repo.id = ?1`)
    .get(repoId);
  return row ? toRepo(row) : undefined;
}

export interface ListReposOptions {
  /** Case-insensitive substring of `owner/name` — the list page's filter box. */
  query?: string;
  /** Page size. @default LIST_LIMIT (max LIST_LIMIT_MAX) */
  limit?: number;
  /** Resume after this repo id (exclusive) — lists run newest first. */
  cursor?: string;
}

// Visibility in SQL: public, owned, or owned by an org the viewer is on a
// team of. Site admins see everything. The same rule canRead applies, so a
// listing never shows a repo whose page would 404.
const VISIBLE = `(
  repo.visibility = 'public'
  OR repo.owner_id = ?1
  OR repo.owner_id IN (
    SELECT team.org_id FROM team
    JOIN team_member ON team_member.team_id = team.id
    WHERE team_member.user_id = ?1)
  OR EXISTS (SELECT 1 FROM user AS me WHERE me.id = ?1 AND me.is_admin = 1)
)`;

export function listReposVisibleTo(
  db: Database,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  const params: (string | number)[] = [viewer?.id ?? ""];
  let where = viewer ? VISIBLE : "repo.visibility = 'public'";
  if (options.query !== undefined && options.query.trim() !== "") {
    params.push(`%${likeEscape(options.query.trim())}%`);
    const p = params.length;
    where += ` AND (repo.name LIKE ?${p} ESCAPE '\\' COLLATE NOCASE
      OR user.username LIKE ?${p} ESCAPE '\\' COLLATE NOCASE)`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND repo.id < ?${params.length}`;
  }
  params.push(pageLimit(options.limit));
  const rows = db
    .query<RepoRow, (string | number)[]>(
      `${SELECT} WHERE ${where} ORDER BY repo.id DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRepo);
  return withCounts(db, rows);
}

/** Repos owned by one user or org, visible to the viewer. */
export function listReposByOwner(
  db: Database,
  ownerName: string,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  const params: (string | number)[] = [viewer?.id ?? "", ownerName];
  let where = `user.username = ?2 COLLATE NOCASE AND ${
    viewer ? VISIBLE : "repo.visibility = 'public'"
  }`;
  if (options.query !== undefined && options.query.trim() !== "") {
    params.push(`%${likeEscape(options.query.trim())}%`);
    const p = params.length;
    where += ` AND (repo.name LIKE ?${p} ESCAPE '\\' COLLATE NOCASE
      OR user.username LIKE ?${p} ESCAPE '\\' COLLATE NOCASE)`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND repo.id < ?${params.length}`;
  }
  params.push(pageLimit(options.limit));
  const rows = db
    .query<RepoRow, (string | number)[]>(
      `${SELECT} WHERE ${where} ORDER BY repo.id DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRepo);
  return withCounts(db, rows);
}

/**
 * Delete a repo. Row first, then disk — inverse of creation, same invariant.
 * Before removing the objects, detach every fork that borrows them (repack so
 * the fork owns its objects, then drop its alternates link) — otherwise a
 * fork would be silently corrupted. This is the detach-before-delete rule.
 */
export async function deleteRepo(
  db: Database,
  reposRoot: string,
  repo: Repo,
): Promise<Result<void, "delete_failed">> {
  const forks = listForks(db, repo.id);
  for (const fork of forks) {
    const forkDir = repoDir(reposRoot, fork.ownerName, fork.name);
    const detached = await detachFork(forkDir);
    if (!detached.ok) {
      // Refuse rather than orphan a fork's objects.
      log.error("cannot detach fork before parent delete", {
        parent: `${repo.ownerName}/${repo.name}`,
        fork: `${fork.ownerName}/${fork.name}`,
      });
      return err("delete_failed");
    }
    db.query("UPDATE repo SET fork_parent_id = NULL WHERE id = ?1").run(
      fork.id,
    );
  }

  db.query("DELETE FROM repo WHERE id = ?1").run(repo.id);
  const removed = await deleteRepoDir(
    repoDir(reposRoot, repo.ownerName, repo.name),
  );
  if (!removed.ok) return err("delete_failed");
  return ok();
}

// Permissions. A personal repo is governed by ownership; an org's repo by the
// caller's team access in that org. Site admins see and do everything.

function personalOrDirect(repo: Repo, user: User | undefined): boolean {
  return user !== undefined && (user.id === repo.ownerId || user.isAdmin);
}

/** Resolve org access for an org-owned repo, or "none" for a personal repo. */
function orgAccessFor(
  db: Database,
  repo: Repo,
  user: User | undefined,
): Access {
  const owner = getUserById(db, repo.ownerId);
  if (owner?.kind !== "org") return "none";
  return orgAccess(db, repo.ownerId, user);
}

export function canRead(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (repo.visibility === "public") return true;
  if (personalOrDirect(repo, user)) return true;
  return accessAllows(orgAccessFor(db, repo, user), "read");
}

export function canWrite(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (personalOrDirect(repo, user)) return true;
  return accessAllows(orgAccessFor(db, repo, user), "write");
}

/** Admin over a repo (settings, delete, webhooks, protection). */
export function canAdmin(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (personalOrDirect(repo, user)) return true;
  return accessAllows(orgAccessFor(db, repo, user), "admin");
}

export interface RepoSettings {
  visibility?: "public" | "private";
  description?: string;
  protectDefault?: boolean;
  /** The caller must have pointed git HEAD at this branch first. */
  defaultBranch?: string;
}

/** Update the mutable repo fields, leaving unspecified ones untouched. */
export function updateRepoSettings(
  db: Database,
  repo: Repo,
  settings: RepoSettings,
): Repo {
  db.query(
    "UPDATE repo SET visibility = ?1, description = ?2, protect_default = ?3, default_branch = ?4 WHERE id = ?5",
  ).run(
    settings.visibility ?? repo.visibility,
    settings.description ?? repo.description,
    (settings.protectDefault ?? repo.protectDefault) ? 1 : 0,
    settings.defaultBranch ?? repo.defaultBranch,
    repo.id,
  );
  return getRepoById(db, repo.id)!;
}
