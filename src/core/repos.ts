/**
 * Repositories: a row in the index and a bare repo on disk. Ordering
 * invariant, paid for elsewhere: the git directory becomes durable BEFORE
 * the row that references it, so a visible row always means a clonable
 * repo. Deletion inverts the order — row first, directory second.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { installHooks } from "../git/hooks.ts";
import { deleteRepoDir, initBareRepo, repoDir } from "../git/repos.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { User } from "./users.ts";

export interface Repo {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly defaultBranch: string;
  readonly protectDefault: boolean;
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
  return ok({
    id: repoId,
    ownerId: input.ownerId,
    ownerName: owner.username,
    name: input.name,
    visibility: input.visibility ?? "private",
    description: input.description ?? "",
    defaultBranch: branch,
    protectDefault: false,
  });
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

/** Row first, then disk — inverse of creation, same invariant. */
export async function deleteRepo(
  db: Database,
  reposRoot: string,
  repo: Repo,
): Promise<Result<void, "delete_failed">> {
  db.query("DELETE FROM repo WHERE id = ?1").run(repo.id);
  const removed = await deleteRepoDir(
    repoDir(reposRoot, repo.ownerName, repo.name),
  );
  if (!removed.ok) return err("delete_failed");
  return ok();
}

// Permissions, v1: owners own; public is readable. Collaborators come later
// as rows, not as special cases scattered through handlers.

export function canRead(repo: Repo, user: User | undefined): boolean {
  if (repo.visibility === "public") return true;
  return user !== undefined && (user.id === repo.ownerId || user.isAdmin);
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

export function canWrite(repo: Repo, user: User | undefined): boolean {
  return user !== undefined && (user.id === repo.ownerId || user.isAdmin);
}
