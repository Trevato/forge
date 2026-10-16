/**
 * Reading a conflicted pull's blocks, for any surface that shows them. A
 * writer only (the same rule as the Resolve page); it reads, it writes nothing.
 */

import type { App } from "../app.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { pullDir, pullStatus, type Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { readConflictedFiles } from "../git/conflict-file.ts";
import { parseConflicts, type Block, type Conflicted } from "../git/conflicts.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface ConflictedFile {
  readonly path: string;
  readonly blocks: readonly Block[];
  /** The file cut into text and blocks, for applying choices. */
  readonly parsed: Conflicted;
}

export interface PullConflicts {
  /** The base branch's side, and the pull branch's. */
  readonly ours: string;
  readonly theirs: string;
  /** The commits these blocks were read at, for Finish to check. */
  readonly headOid: string;
  readonly baseOid: string;
  readonly files: readonly ConflictedFile[];
}

export async function pullConflicts(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Promise<Result<PullConflicts, "forbidden">> {
  if (!canWrite(app.db, repo, actor)) return err("forbidden");
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const status = await pullStatus(dir, pull);
  const files: ConflictedFile[] = [];
  const texts = await readConflictedFiles(dir, status.baseOid, status.headOid, status.conflicts);
  for (const path of status.conflicts) {
    const parsed = parseConflicts(texts.get(path) ?? "");
    files.push({ path, blocks: parsed.blocks, parsed });
  }
  return ok({
    ours: pull.baseBranch,
    theirs: pull.headBranch,
    headOid: status.headOid,
    baseOid: status.baseOid,
    files,
  });
}
