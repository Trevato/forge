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
import { accessAllows, orgAccess, type Access } from "./orgs.ts";
import { getUserById, type User } from "./users.ts";

const log = createLog("repos");

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
}

const SELECT = `
  SELECT repo.*, user.username AS owner_name
  FROM repo JOIN user ON user.id = repo.owner_id`;

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
  };
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

export function listReposVisibleTo(
  db: Database,
  viewer: User | undefined,
): Repo[] {
  const rows = viewer
    ? db
        .query<
          RepoRow,
          [string]
        >(`${SELECT} WHERE repo.visibility = 'public' OR repo.owner_id = ?1 ORDER BY repo.id DESC`)
        .all(viewer.id)
    : db
        .query<
          RepoRow,
          []
        >(`${SELECT} WHERE repo.visibility = 'public' ORDER BY repo.id DESC`)
        .all();
  return rows.map(toRepo);
}

/** Repos owned by one user or org, visible to the viewer. */
export function listReposByOwner(
  db: Database,
  ownerName: string,
  viewer: User | undefined,
): Repo[] {
  const rows = db
    .query<
      RepoRow,
      [string]
    >(`${SELECT} WHERE user.username = ?1 COLLATE NOCASE ORDER BY repo.id DESC`)
    .all(ownerName);
  return rows.map(toRepo).filter((repo) => canRead(db, repo, viewer));
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
}

/** Update the mutable repo fields, leaving unspecified ones untouched. */
export function updateRepoSettings(
  db: Database,
  repo: Repo,
  settings: RepoSettings,
): Repo {
  db.query(
    "UPDATE repo SET visibility = ?1, description = ?2, protect_default = ?3 WHERE id = ?4",
  ).run(
    settings.visibility ?? repo.visibility,
    settings.description ?? repo.description,
    (settings.protectDefault ?? repo.protectDefault) ? 1 : 0,
    repo.id,
  );
  return getRepoById(db, repo.id)!;
}
