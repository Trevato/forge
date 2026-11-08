/**
 * Bare repository lifecycle. Repos live at `<root>/<owner>/<name>.git` in
 * plain layout — a data directory you can read with `ls` and export with
 * `tar`. Sovereignty starts with the filesystem being legible.
 */

import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { defect } from "../kernel/error.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { runGit, type GitFailure } from "./env.ts";
import { isSafeName, isSafeRef } from "./guard.ts";

/** Resolve a repo's on-disk directory, refusing unsafe segments outright. */
export function repoDir(root: string, owner: string, name: string): string {
  if (!isSafeName(owner) || !isSafeName(name)) {
    defect(
      "git.unsafe_repo_segment",
      `unsafe repo path segment: ${owner}/${name}`,
    );
  }
  return join(root, owner, `${name}.git`);
}

export async function repoExists(dir: string): Promise<boolean> {
  return await Bun.file(join(dir, "HEAD")).exists();
}

export interface InitRepoOptions {
  /** @default "main" */
  defaultBranch?: string;
}

export async function initBareRepo(
  dir: string,
  options: InitRepoOptions = {},
): Promise<Result<void, GitFailure>> {
  const branch = options.defaultBranch ?? "main";
  if (!isSafeRef(branch))
    defect("git.unsafe_ref", `unsafe default branch: ${branch}`);

  const init = await runGit([
    "init",
    "--bare",
    "--initial-branch",
    branch,
    dir,
  ]);
  if (!init.ok) return init;

  // Reflogs are off in bare repos by default; a forge wants the audit trail.
  const reflog = await runGit(["config", "core.logAllRefUpdates", "true"], {
    cwd: dir,
  });
  if (!reflog.ok) return reflog;

  return ok();
}

/**
 * Fork a bare repo. `--shared` points the new repo's object store at the
 * parent's via alternates, so the fork is created instantly and stores only
 * its own new objects. Refs are copied at fork time. The parent's objects must
 * outlive the fork until it is detached (see detachFork).
 */
export async function forkBareRepo(
  parentDir: string,
  forkDir: string,
): Promise<Result<void, GitFailure>> {
  const clone = await runGit(
    ["clone", "--bare", "--shared", parentDir, forkDir],
    {
      timeoutMs: 120_000,
    },
  );
  if (!clone.ok) return clone;
  const reflog = await runGit(["config", "core.logAllRefUpdates", "true"], {
    cwd: forkDir,
  });
  if (!reflog.ok) return await undo(forkDir, reflog);
  // A bare clone carries heads and tags only. A pin's refs ride with it:
  // the build, its cover and its curated screenshots.
  const pins = await runGit(
    [
      "fetch",
      "--no-tags",
      parentDir,
      "+refs/builds/*:refs/builds/*",
      "+refs/covers/*:refs/covers/*",
      "+refs/shots/*:refs/shots/*",
    ],
    { cwd: forkDir, timeoutMs: 120_000 },
  );
  if (!pins.ok) return await undo(forkDir, pins);
  return ok();
}

/** A fork half made is no fork: remove it, so a second try finds a free place. */
async function undo<E>(forkDir: string, failure: E): Promise<E> {
  await rm(forkDir, { recursive: true, force: true });
  return failure;
}

/**
 * Make a fork self-contained: absorb every borrowed object into the fork's own
 * packs, then drop the alternates link. After this the parent can be deleted
 * without corrupting the fork — the "detach before delete" invariant.
 */
export async function detachFork(
  forkDir: string,
): Promise<Result<void, GitFailure>> {
  // -a repacks everything into one local pack. Crucially we do NOT pass -l
  // (--local): without it, pack-objects copies the borrowed alternate objects
  // into this repo, which is exactly the absorption we need before cutting the
  // alternates link.
  const repack = await runGit(["repack", "-a", "-d"], {
    cwd: forkDir,
    timeoutMs: 300_000,
  });
  if (!repack.ok) return repack;
  await rm(join(forkDir, "objects", "info", "alternates"), { force: true });
  return ok();
}

/** Does this bare repo borrow objects from a parent via alternates? */
export async function hasAlternates(dir: string): Promise<boolean> {
  return await Bun.file(join(dir, "objects", "info", "alternates")).exists();
}

export async function setDefaultBranch(
  dir: string,
  branch: string,
): Promise<Result<void, GitFailure>> {
  if (!isSafeRef(branch)) defect("git.unsafe_ref", `unsafe branch: ${branch}`);
  const result = await runGit(
    ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
    { cwd: dir },
  );
  return result.ok ? ok() : result;
}

/** Is anything at this path? Keyed on the directory, so a half-removed repo counts. */
export async function repoDirExists(dir: string): Promise<boolean> {
  return await stat(dir).then(
    () => true,
    () => false,
  );
}

/**
 * Permanently delete a repository directory. The caller owns the ceremony.
 * Presence is the directory, not HEAD: a removal that died partway leaves no
 * HEAD but still leaves files, and a retry must finish the job.
 */
export async function deleteRepoDir(
  dir: string,
): Promise<Result<void, { message: string }>> {
  if (!dir.endsWith(".git")) {
    defect("git.refuse_delete", `refusing to delete non-repo path: ${dir}`);
  }
  if (!(await repoDirExists(dir)))
    return err({ message: `not a repository: ${dir}` });
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    return err({ message: e instanceof Error ? e.message : String(e) });
  }
  return ok();
}
