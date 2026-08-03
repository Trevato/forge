/**
 * Bare repository lifecycle. Repos live at `<root>/<owner>/<name>.git` in
 * plain layout — a data directory you can read with `ls` and export with
 * `tar`. Sovereignty starts with the filesystem being legible.
 */

import { join } from "node:path";
import { rm } from "node:fs/promises";
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

/** Permanently delete a repository directory. The caller owns the ceremony. */
export async function deleteRepoDir(
  dir: string,
): Promise<Result<void, { message: string }>> {
  if (!dir.endsWith(".git")) {
    defect("git.refuse_delete", `refusing to delete non-repo path: ${dir}`);
  }
  if (!(await repoExists(dir)))
    return err({ message: `not a repository: ${dir}` });
  await rm(dir, { recursive: true, force: true });
  return ok();
}
