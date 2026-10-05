/**
 * Repositories: a row in the index and a bare repo on disk. Ordering
 * invariant, paid for elsewhere: the git directory becomes durable BEFORE
 * the row that references it, so a visible row always means a clonable
 * repo. Deletion inverts the order — row first, directory second.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { installHooks } from "../git/hooks.ts";
import { closeReader } from "../git/read.ts";
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
import { REPO_VISIBLE, REPO_WRITABLE } from "./visibility.ts";
import {
  accessAllows,
  orgAccess,
  orgAccessByOrg,
  type Access,
} from "./orgs.ts";
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

export type Autonomy = "off" | "assisted" | "autonomous";
export const AUTONOMY: readonly Autonomy[] = ["off", "assisted", "autonomous"];
export const isAutonomy = (value: unknown): value is Autonomy =>
  (AUTONOMY as readonly unknown[]).includes(value);

export interface Repo {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly defaultBranch: string;
  readonly protectDefault: boolean;
  /**
   * Whether a pull needs an approval of its current head before it merges.
   * Mechanical, not advisory: `mergePull` refuses `review_required`.
   */
  readonly requireReview: boolean;
  /**
   * Whether a pull's current head must have a passing deploy run before it
   * merges. Read live inside `mergePull`, like `requireReview`.
   */
  readonly requireChecks: boolean;
  /**
   * How much the crew does here on its own (docs/PLANNING.md): `off`, every
   * run starts because a person acted; `assisted`, the crew works what is
   * ready and green waits for a look; `autonomous`, green ships and an empty
   * map wakes the planner. `autonomyBy` is the person the forge acts as.
   */
  readonly autonomy: Autonomy;
  readonly autonomyDirection: string;
  readonly autonomyCeilingUsd: number;
  readonly autonomySlots: number;
  readonly autonomyBy: string | null;
  /**
   * "Outsiders may trigger the crew": whether someone who cannot write here
   * may still start or steer a run by speaking (`crew/direct.ts`). Off by
   * default; on a public repository it hands strangers the owner's budget.
   */
  readonly crewOutsiders: boolean;
  /** The issue the planner is given, when the map has run dry. */
  readonly directionIssueId: string | null;
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
  require_review: number;
  require_checks: number;
  autonomy: string;
  autonomy_direction: string;
  autonomy_ceiling_usd: number;
  autonomy_slots: number;
  autonomy_by: string | null;
  crew_outsiders: number;
  direction_issue_id: string | null;
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
    requireReview: row.require_review === 1,
    requireChecks: row.require_checks === 1,
    autonomy: isAutonomy(row.autonomy) ? row.autonomy : "off",
    autonomyDirection: row.autonomy_direction,
    autonomyCeilingUsd: row.autonomy_ceiling_usd,
    autonomySlots: row.autonomy_slots,
    autonomyBy: row.autonomy_by,
    crewOutsiders: row.crew_outsiders === 1,
    directionIssueId: row.direction_issue_id,
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
/** The fork of `parentId` that `ownerId` holds, if any: one per owner. */
export function getForkOf(
  db: Database,
  ownerId: string,
  parentId: string,
): Repo | undefined {
  const row = db
    .query<
      RepoRow,
      [string, string]
    >(`${SELECT} WHERE repo.owner_id = ?1 AND repo.fork_parent_id = ?2`)
    .get(ownerId, parentId);
  return row ? toRepo(row) : undefined;
}

export function listForks(db: Database, repoId: string): Repo[] {
  return db
    .query<
      RepoRow,
      [string]
    >(`${SELECT} WHERE repo.fork_parent_id = ?1 ORDER BY repo.id`)
    .all(repoId)
    .map(toRepo);
}

/**
 * The repository this one was forked from, while that parent is still here
 * and the viewer may read it. A fork's lineage — the parent's name, and how
 * far the fork has drifted from it — is a fact about the parent, so a fork
 * that has been opened up never speaks for a parent that has not.
 */
export function forkParentFor(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Repo | undefined {
  const parent =
    repo.forkParentId === null ? undefined : getRepoById(db, repo.forkParentId);
  return parent !== undefined && canRead(db, parent, viewer)
    ? parent
    : undefined;
}

/** The forks of this repository the viewer may see — the list, and its count. */
export function visibleForks(
  db: Database,
  repoId: string,
  viewer: User | undefined,
): Repo[] {
  return listForks(db, repoId).filter((fork) => canRead(db, fork, viewer));
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

/**
 * Several repos by id, in one query, keyed by id. What a pin list, an
 * activity feed, or any other page holding a bag of repo ids should ask,
 * instead of `getRepoById` in a loop.
 */
export function getReposByIds(
  db: Database,
  repoIds: readonly string[],
): Map<string, Repo> {
  const out = new Map<string, Repo>();
  const CHUNK = 400;
  const unique = [...new Set(repoIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        RepoRow,
        string[]
      >(`${SELECT} WHERE repo.id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch);
    for (const row of rows) out.set(row.id, toRepo(row));
  }
  return out;
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
// The rule itself lives in visibility.ts, because the activity feed needs the
// same one and two copies of an access rule is how a forge grows a leak.
const VISIBLE = REPO_VISIBLE;

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

/**
 * Repos this viewer may write: their own, or an org's through a team with
 * write or admin access — `REPO_WRITABLE`, the SQL twin of `canWrite`, for a
 * list of rows rather than one permission check per row. An anonymous viewer
 * writes nothing.
 */
export function listReposWritableTo(
  db: Database,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  if (!viewer) return [];
  const params: (string | number)[] = [viewer.id];
  let where = REPO_WRITABLE;
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
  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  // A pooled `cat-file` holds this directory open. Closing it first is what
  // keeps the space actually free after the unlink instead of pinned to a
  // descriptor nobody will ever read again.
  closeReader(dir);
  const removed = await deleteRepoDir(dir);
  if (!removed.ok) return err("delete_failed");
  return ok();
}

// Permissions. A personal repo is governed by ownership; an org's repo by the
// caller's team access in that org. Site admins see and do everything. An
// agent on a repo's crew reads it — and only that: the crew works from
// forks, so an agent writes what it owns and proposes the rest, and
// everything from write up stays with people.

function personalOrDirect(repo: Repo, user: User | undefined): boolean {
  return user !== undefined && (user.id === repo.ownerId || user.isAdmin);
}

function onCrew(db: Database, repo: Repo, user: User | undefined): boolean {
  if (user === undefined || user.kind !== "agent") return false;
  return (
    db
      .query<
        { n: number },
        [string, string]
      >("SELECT 1 AS n FROM repo_crew WHERE repo_id = ?1 AND user_id = ?2")
      .get(repo.id, user.id) !== null
  );
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
  if (onCrew(db, repo, user)) return true;
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

/**
 * Money, the crew roster, autonomy limits and a run's own cost describe
 * running the app, not what it is — a stranger who can only read a public
 * app sees what it does and what it has shipped, never what it costs or
 * who is on it. The same test as `canWrite`, named for what it decides
 * here, so every surface that shows one of these facts asks this one
 * question rather than inventing its own.
 */
export function canSeeOwnerFacts(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  return canWrite(db, repo, user);
}

/**
 * `canSeeOwnerFacts` for many repositories at once: the ids of those whose
 * owner facts the user may see. The same rules as `canWrite` — owner, site
 * admin, or a write/admin team in the owning org (no crew grant, unlike
 * `REPO_WRITABLE`) — answered from one read of the user's teams, so a list
 * does not pay a user lookup and a permission query per row.
 */
export function ownerFactRepoIds(
  db: Database,
  repos: readonly Repo[],
  user: User | undefined,
): Set<string> {
  const out = new Set<string>();
  if (user === undefined) return out;
  const orgs = user.isAdmin
    ? new Map<string, Access>()
    : orgAccessByOrg(db, user);
  for (const repo of repos)
    if (
      personalOrDirect(repo, user) ||
      accessAllows(orgs.get(repo.ownerId) ?? "none", "write")
    )
      out.add(repo.id);
  return out;
}

/**
 * Which of these repositories the user may write — `canWrite` for many rows
 * in one query per chunk, through `REPO_WRITABLE`. The dashboard's inbox
 * asks this for every crew pull it shows; asked per row that was a
 * permission check, and a user lookup, per pull.
 */
export function writableRepoIds(
  db: Database,
  user: User | undefined,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (user === undefined) return out;
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT repo.id FROM repo
         WHERE repo.id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
           AND ${REPO_WRITABLE}`,
      )
      .all(user.id, ...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
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
  /** Require an approval of a pull's current head before it may merge. */
  requireReview?: boolean;
  /** Require a passing deploy of a pull's current head before it may merge. */
  requireChecks?: boolean;
  /** The caller must have pointed git HEAD at this branch first. */
  defaultBranch?: string;
  autonomy?: Autonomy;
  autonomyDirection?: string;
  autonomyCeilingUsd?: number;
  autonomySlots?: number;
  /** Who the forge acts as when it assigns and lands on its own. */
  autonomyBy?: string | null;
  /** Whether someone who cannot write here may start or steer a run. */
  crewOutsiders?: boolean;
}

/** Update the mutable repo fields, leaving unspecified ones untouched. */
export function updateRepoSettings(
  db: Database,
  repo: Repo,
  settings: RepoSettings,
): Repo {
  db.query(
    `UPDATE repo SET visibility = ?1, description = ?2, protect_default = ?3,
       default_branch = ?4, require_review = ?5, require_checks = ?7,
       autonomy = ?8, autonomy_direction = ?9, autonomy_ceiling_usd = ?10,
       autonomy_slots = ?11, autonomy_by = ?12, crew_outsiders = ?13
     WHERE id = ?6`,
  ).run(
    settings.visibility ?? repo.visibility,
    settings.description ?? repo.description,
    (settings.protectDefault ?? repo.protectDefault) ? 1 : 0,
    settings.defaultBranch ?? repo.defaultBranch,
    (settings.requireReview ?? repo.requireReview) ? 1 : 0,
    repo.id,
    (settings.requireChecks ?? repo.requireChecks) ? 1 : 0,
    settings.autonomy ?? repo.autonomy,
    settings.autonomyDirection ?? repo.autonomyDirection,
    settings.autonomyCeilingUsd ?? repo.autonomyCeilingUsd,
    settings.autonomySlots ?? repo.autonomySlots,
    settings.autonomyBy === undefined ? repo.autonomyBy : settings.autonomyBy,
    (settings.crewOutsiders ?? repo.crewOutsiders) ? 1 : 0,
  );
  return getRepoById(db, repo.id)!;
}

/** Repositories the crew drives on its own, assisted or autonomous. */
/** Every repository the forge holds, for the snapshot: nothing is left out. */
export function listEveryRepo(db: Database): Repo[] {
  return db
    .query<RepoRow, []>(`${SELECT} ORDER BY owner_name, repo.name`)
    .all()
    .map(toRepo);
}

export function listAutonomousRepos(db: Database): Repo[] {
  return db
    .query<
      RepoRow,
      []
    >(`${SELECT} WHERE repo.autonomy != 'off' ORDER BY repo.name`)
    .all()
    .map(toRepo);
}

export function setDirectionIssue(
  db: Database,
  repoId: string,
  issueId: string | null,
): void {
  db.query("UPDATE repo SET direction_issue_id = ?2 WHERE id = ?1").run(
    repoId,
    issueId,
  );
}
