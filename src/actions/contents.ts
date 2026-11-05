/**
 * Editing files as one action.
 *
 * "Change these files, on a new branch, and open a pull" is a single
 * intention — a person doing it in a web editor, and an agent doing it a
 * thousand times an hour, want the same call. Splitting it across three
 * round trips is how half-finished states (a branch with no commit, a commit
 * with no pull) get invented, so it is one function with one Result.
 *
 * It is built on `git/write.ts` — plumbing into a temporary index, no work
 * tree — and on the branch action, so a mirrored repo goes through its origin
 * exactly as `actions/branches.ts` describes: the objects are written
 * locally, the origin is asked, and the local ref moves only if it agreed.
 */

import { contributionRefusal } from "../core/storage.ts";
import type { App } from "../app.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { trackPullHead, type Pull } from "../core/pulls.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import type { User } from "../core/users.ts";
import { isSafeTreePath } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import {
  commitFiles,
  type CommitFilesError,
  type CommitResult,
} from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { WriteThroughError } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { createBranch, deleteBranch, originPush } from "./branches.ts";
import { openPull as openPullAction } from "./pulls.ts";

/** Per-file ceiling. Anything larger belongs in a push, not a JSON body. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Per-commit ceiling, across every file in the edit. */
export const MAX_COMMIT_BYTES = 10 * 1024 * 1024;
/** A bound on fan-out, so one request cannot mean ten thousand blobs. */
export const MAX_FILES = 1_000;

const ZERO = "0".repeat(40);

export interface EditFile {
  readonly path: string;
  /** The file's new contents, or `null` to delete it. */
  readonly content: string | Uint8Array | null;
}

export interface EditFilesInput {
  /** The branch to commit to. @default the repo's default branch */
  branch?: string;
  /** Where a new branch forks from. @default `branch`, else the default */
  base?: string;
  /** @default "Update files" */
  message?: string;
  readonly files: readonly EditFile[];
  /** Create this branch first and commit there instead. */
  newBranch?: string;
  /** Open a pull from the branch just written back to `base`. */
  openPull?: { title: string; body?: string };
}

export interface EditResult {
  readonly commit: CommitResult;
  /** The branch the commit landed on. */
  readonly branch: string;
  readonly pull?: Pull;
}

export type EditFilesError =
  | { kind: "storage_limit" }
  | AccessError
  | WriteThroughError
  | CommitFilesError
  | { kind: "too_many_files"; count: number }
  | { kind: "file_too_large"; path: string; bytes: number }
  | { kind: "commit_too_large"; bytes: number }
  | { kind: "protected_branch"; branch: string }
  /** The same path named twice in one edit — which content was meant? */
  | { kind: "duplicate_path"; path: string }
  /**
   * The branch could not be made; `reason` is the branch action's own code.
   * (Not `error`: an adapter that spreads this object next to its own
   * `error` code must not have the stable code overwritten by the detail.)
   */
  | { kind: "branch_failed"; reason: string }
  /** The commit landed; only the proposal did not open. */
  | { kind: "pull_failed"; reason: string; commit: CommitResult };

/** The access and write-through codes, which travel as bare strings. */
const PASSTHROUGH = new Set([
  "not_found",
  "unauthorized",
  "forbidden",
  "origin_owner_only",
  "origin_unreachable",
  "origin_refused",
]);

const sizeOf = (content: string | Uint8Array): number =>
  typeof content === "string"
    ? Buffer.byteLength(content, "utf8")
    : content.length;

/**
 * Write files to a branch, optionally onto a fresh branch, optionally
 * proposing them back. Every check that can be made up front is made up
 * front, so a refused edit writes nothing. The one step that can fail after
 * the commit has landed is opening the pull, and that failure carries the
 * commit with it rather than pretending nothing happened.
 */
export async function editFiles(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: EditFilesInput,
): Promise<Result<EditResult, EditFilesError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if ((await contributionRefusal(app, writer.value.id, repo, writer.value)) !== undefined)
    return err({ kind: "storage_limit" });

  if (input.files.length === 0) return err({ kind: "no_files" });
  if (input.files.length > MAX_FILES)
    return err({ kind: "too_many_files", count: input.files.length });

  let total = 0;
  const seen = new Set<string>();
  for (const file of input.files) {
    if (!isSafeTreePath(file.path))
      return err({ kind: "invalid_path", path: file.path });
    // Two entries for one path is an ambiguous request, not a last-wins one:
    // a retrying agent that concatenated two edits must hear about it.
    if (seen.has(file.path))
      return err({ kind: "duplicate_path", path: file.path });
    seen.add(file.path);
    if (file.content === null) continue;
    const bytes = sizeOf(file.content);
    if (bytes > MAX_FILE_BYTES)
      return err({ kind: "file_too_large", path: file.path, bytes });
    total += bytes;
  }
  if (total > MAX_COMMIT_BYTES)
    return err({ kind: "commit_too_large", bytes: total });

  // Where the work lands, and where a new branch forks from. `base` is the
  // fork point and the pull's target; `branch` is the working branch. With
  // no new branch asked for, a working branch that does not exist yet forks
  // from the default — never from nothing. A typo in `branch` must not mint
  // an orphan history with one file in it (the same rule `commitToBranch`
  // applies); on an empty repo there is no default tip, and the commit is a
  // root commit exactly as before.
  const working = (input.branch ?? "").trim() || repo.defaultBranch;
  const fresh = (input.newBranch ?? "").trim();
  const base =
    (input.base ?? "").trim() || (fresh !== "" ? working : repo.defaultBranch);
  const branch = fresh || working;

  // Protection is mechanical: a protected default takes commits from repo
  // admins only, and never from an ordinary writer, however they arrived.
  if (
    branch === repo.defaultBranch &&
    repo.protectDefault &&
    !canAdmin(app.db, repo, writer.value)
  ) {
    return err({ kind: "protected_branch", branch });
  }

  if (fresh !== "") {
    const created = await createBranch(app, writer.value, repo, {
      name: fresh,
      from: base,
    });
    if (!created.ok) {
      return PASSTHROUGH.has(created.error)
        ? err(created.error as AccessError | WriteThroughError)
        : err({ kind: "branch_failed", reason: created.error });
    }
  }

  // A mirror's refs belong to its origin; resolve the push before writing
  // anything, so an unusable credential costs no objects.
  const push = await originPush(app, writer.value, repo);
  if (!push.ok) return push;
  const send = push.value;

  const committed = await commitFiles(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    {
      branch,
      ...(branch !== base ? { startPoint: base } : {}),
      message: input.message?.trim() || "Update files",
      files: input.files,
      author: commitIdentity(app.config, writer.value),
      ...(send === undefined
        ? {}
        : {
            land: (commitOid, tip) =>
              send([
                {
                  ref: `refs/heads/${branch}`,
                  oldOid: tip ?? ZERO,
                  newOid: commitOid,
                },
              ]),
          }),
    },
  );
  if (!committed.ok) {
    // The branch was made for this commit and the commit did not land: take
    // the branch back (upstream too, on a mirror) so a refused edit leaves
    // no branch behind with nothing on it — the half-finished state this
    // call exists to prevent. The rollback is best-effort; the edit's own
    // error is what the caller needs to hear.
    if (fresh !== "") await deleteBranch(app, writer.value, repo, fresh);
    return committed;
  }

  // A same-repo pull whose head is this branch follows the commit before
  // anything hears about it, so a check or a deploy triggered below never
  // reads a row the branch has already moved past.
  trackPullHead(app.db, repo.id, branch, committed.value.commitOid);

  // `update-ref` runs no hooks, so the push is announced here — webhooks,
  // SSE and CI see it exactly as they would a `git push`.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      updates: [
        { ref: `refs/heads/${branch}`, newOid: committed.value.commitOid },
      ],
      viaApi: true,
    },
  });

  if (input.openPull === undefined)
    return ok({ commit: committed.value, branch });

  const pull = await openPullAction(app, writer.value, repo, {
    title: input.openPull.title,
    body: input.openPull.body ?? "",
    baseBranch: base,
    headBranch: branch,
  });
  // The commit landed; a refused pull does not un-land it. The failure
  // carries the commit so a caller learns both facts at once.
  if (!pull.ok)
    return err({
      kind: "pull_failed",
      reason: pull.error,
      commit: committed.value,
    });
  return ok({ commit: committed.value, branch, pull: pull.value });
}
