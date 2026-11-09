/**
 * Moving a repository to another owner (#569): the storage half. The bare
 * repository is renamed on disk, then one transaction gives the repo row its
 * new owner and records where the old path went (`repo_redirect`). When the
 * transaction fails the directory is renamed back, so disk and rows never
 * disagree. Everything else about a repository — its app, secrets, crew,
 * autonomy, direction, issues and pulls — is keyed by the repo's id, so it
 * travels with the row; an app's data lives under its app id and does not
 * move. A fork's `alternates` file names its parent's objects by absolute
 * path, so each fork's is rewritten to the new place.
 */

import type { Database } from "bun:sqlite";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { closeReader } from "../git/read.ts";
import { repoDir, repoDirExists } from "../git/repos.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { forgetListings } from "./listings.ts";
import { getRepo, getRepoById, listForks, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

export type TransferError = "name_taken" | "same_owner" | "move_failed";

/**
 * The old owner/name pairs, held in process memory per database so the
 * common request — under a path nothing moved from — costs no statement.
 * Loaded on first use; `transferRepo` drops it. A pair whose row has gone
 * (its repository deleted) only costs the one lookup that finds nothing.
 */
const moved = new WeakMap<Database, Set<string>>();
const key = (ownerName: string, name: string): string => `${ownerName.toLowerCase()}/${name.toLowerCase()}`;

function movedPaths(db: Database): Set<string> {
  let paths = moved.get(db);
  if (paths === undefined) {
    paths = new Set(
      db
        .query<{ owner_name: string; name: string }, []>("SELECT owner_name, name FROM repo_redirect")
        .all()
        .map((r) => key(r.owner_name, r.name)),
    );
    moved.set(db, paths);
  }
  return paths;
}

/** Where an old owner/name went, when no repository answers there now. */
export function redirectFor(db: Database, ownerName: string, name: string): Repo | undefined {
  if (!movedPaths(db).has(key(ownerName, name))) return undefined;
  const row = db
    .query<{ repo_id: string }, [string, string]>(
      "SELECT repo_id FROM repo_redirect WHERE owner_name = ?1 AND name = ?2",
    )
    .get(ownerName, name);
  if (row === null) return undefined;
  if (getRepo(db, ownerName, name) !== undefined) return undefined;
  return getRepoById(db, row.repo_id);
}

async function rewriteAlternates(forkDir: string, from: string, to: string): Promise<void> {
  const file = join(forkDir, "objects", "info", "alternates");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined || !text.includes(from)) return;
  await writeFile(file, text.split(from).join(to));
}

/**
 * One transfer at a time in this process: the checks (name free, place
 * free), the rename and the transaction run as one step, so two moves to
 * the same owner/name cannot both pass the checks, and a rollback never
 * renames back over a directory another move just put there. Moves are rare;
 * a single queue costs nothing worth a finer lock.
 */
let queue: Promise<unknown> = Promise.resolve();

export function transferRepo(
  db: Database,
  reposRoot: string,
  repo: Repo,
  target: User,
  movedBy: string,
): Promise<Result<Repo, TransferError>> {
  const turn = queue.then(() => moveNow(db, reposRoot, repo, target, movedBy));
  queue = turn.catch(() => undefined);
  return turn;
}

async function moveNow(
  db: Database,
  reposRoot: string,
  stale: Repo,
  target: User,
  movedBy: string,
): Promise<Result<Repo, TransferError>> {
  // The row as it is now, not as the caller read it before waiting its turn.
  const repo = getRepoById(db, stale.id);
  if (repo === undefined) return err("move_failed");
  if (target.id === repo.ownerId) return err("same_owner");
  if (getRepo(db, target.username, repo.name) !== undefined) return err("name_taken");
  const from = repoDir(reposRoot, repo.ownerName, repo.name);
  const to = repoDir(reposRoot, target.username, repo.name);
  if (await repoDirExists(to)) return err("name_taken");
  const hadDir = await repoDirExists(from);
  if (hadDir) {
    closeReader(from);
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch {
      return err("move_failed");
    }
  }
  const fromPath = `${repo.ownerName}/${repo.name}`;
  const toPath = `${target.username}/${repo.name}`;
  try {
    db.transaction(() => {
      db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(target.id, repo.id);
      // The new path is a real repository now; a redirect that pointed it
      // elsewhere would never be read, so it goes.
      db.query("DELETE FROM repo_redirect WHERE owner_name = ?1 AND name = ?2").run(target.username, repo.name);
      db.query(
        `INSERT INTO repo_redirect (owner_name, name, repo_id, moved_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (owner_name, name) DO UPDATE SET repo_id = excluded.repo_id,
             moved_by = excluded.moved_by, created_at = excluded.created_at`,
      ).run(repo.ownerName, repo.name, repo.id, movedBy);
      db.query(
        "INSERT INTO repo_transfer (id, repo_id, from_path, to_path, actor_id) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).run(id(), repo.id, fromPath, toPath, movedBy);
    })();
    moved.delete(db);
  } catch {
    if (hadDir) await rename(to, from).catch(() => undefined);
    return err("move_failed");
  }
  if (hadDir) {
    // The old owner's directory may be empty now; leave it if not.
    await rmdir(dirname(from)).catch(() => undefined);
    const objectsFrom = join(from, "objects");
    const objectsTo = join(to, "objects");
    for (const fork of listForks(db, repo.id)) {
      await rewriteAlternates(repoDir(reposRoot, fork.ownerName, fork.name), objectsFrom, objectsTo).catch(
        () => undefined,
      );
    }
  }
  forgetListings(db);
  const after = getRepoById(db, repo.id);
  return after === undefined ? err("move_failed") : ok(after);
}

export interface TransferRecord {
  readonly from: string;
  readonly to: string;
  readonly actorId: string;
  readonly at: string;
}

/** The audit trail of a repository's moves, oldest first. */
export function transfersOf(db: Database, repoId: string): TransferRecord[] {
  return db
    .query<{ from_path: string; to_path: string; actor_id: string; created_at: string }, [string]>(
      "SELECT from_path, to_path, actor_id, created_at FROM repo_transfer WHERE repo_id = ?1 ORDER BY id",
    )
    .all(repoId)
    .map((r) => ({ from: r.from_path, to: r.to_path, actorId: r.actor_id, at: r.created_at }));
}
