/**
 * Finish a conflicted pull: the person's choices for every conflict block
 * become one commit on the pull's head branch, with the base branch as its
 * second parent, so the pull merges cleanly afterwards. Plumbing only —
 * `merge-tree` makes the tree, a temporary index swaps in the resolved file,
 * `commit-tree` seals it, a compare-and-swap `update-ref` lands it. No work
 * tree, no clone, no agent.
 */

import type { App } from "../app.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { pullStatus, trackPullHead, type Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { conflictedTree, readConflictedFile } from "../git/conflict-file.ts";
import { applyChoices, parseConflicts, type Choice } from "../git/conflicts.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { commitFiles } from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

export type FinishError =
  | AccessError
  | "closed"
  /** Cross-repo and mirrored pulls keep their head elsewhere. */
  | "elsewhere"
  /** The head or the base moved since the page was drawn. */
  | "stale"
  | "no_conflicts"
  /** More conflicted files than the one sent, or one with no text blocks. */
  | "not_resolvable"
  /** A block with no choice. */
  | "incomplete"
  | "protected_branch"
  | "git";

/** What each refusal says, on the page and in the terminal alike. */
export const FINISH_REFUSALS: Record<FinishError, string> = {
  unauthorized: "Sign in to finish a conflict.",
  forbidden: "You do not have write access to this repository.",
  not_found: "That pull request is no longer here.",
  closed: "This pull request is not open. Nothing was written.",
  elsewhere: "This pull's branch lives elsewhere; resolve it there. Nothing was written.",
  stale:
    "The branch moved since this page was drawn, so your choices may not fit it. Nothing was written; look again and choose again.",
  no_conflicts: "This pull no longer conflicts. Nothing was written.",
  not_resolvable:
    "Finish handles a pull with one conflicted text file. Resolve this one in your own checkout. Nothing was written.",
  incomplete: "Every block needs a choice before you finish. Nothing was written.",
  protected_branch: "That branch is protected. Nothing was written.",
  git: "Git refused the commit. Nothing was written.",
};

export async function finishConflicts(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  input: {
    /** The head and base the person saw. */
    readonly headOid: string;
    readonly baseOid: string;
    readonly path: string;
    readonly choices: readonly (Choice | undefined)[];
  },
): Promise<Result<{ commitOid: string }, FinishError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (pull.repoId !== repo.id) return err("not_found");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("closed");
  if (pull.crossRepo || pull.originHeadRepo !== null || repo.origin !== null)
    return err("elsewhere");
  if (
    pull.headBranch === repo.defaultBranch &&
    repo.protectDefault &&
    !canAdmin(app.db, repo, writer.value)
  )
    return err("protected_branch");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const status = await pullStatus(dir, pull);
  if (status.headOid !== input.headOid || status.baseOid !== input.baseOid)
    return err("stale");
  if (status.conflicts.length === 0) return err("no_conflicts");
  if (status.conflicts.length !== 1 || status.conflicts[0] !== input.path)
    return err("not_resolvable");

  const text = await readConflictedFile(
    dir,
    status.baseOid,
    status.headOid,
    input.path,
  );
  const parsed = parseConflicts(text ?? "");
  if (parsed.blocks.length === 0) return err("not_resolvable");
  if (
    input.choices.length < parsed.blocks.length ||
    input.choices.slice(0, parsed.blocks.length).some((c) => c === undefined)
  )
    return err("incomplete");
  const content = applyChoices(parsed, input.choices, {
    ours: pull.baseBranch,
    theirs: pull.headBranch,
  });

  const tree = await conflictedTree(dir, status.baseOid, status.headOid);
  if (tree === undefined) return err("git");
  // Keep the file's mode: a script stays executable.
  const entry = await runGit(["ls-tree", tree, "--", input.path], { cwd: dir });
  const mode = entry.ok ? entry.value.split(" ")[0] : undefined;
  if (mode !== "100644" && mode !== "100755") return err("not_resolvable");

  const committed = await commitFiles(dir, {
    branch: pull.headBranch,
    message: `Merge ${pull.baseBranch} into ${pull.headBranch}\n\nResolved the conflicts in ${input.path}.`,
    files: [{ path: input.path, content, mode }],
    seedTree: tree,
    mergeParents: [status.baseOid],
    expectTip: status.headOid,
    author: commitIdentity(app.config, writer.value),
  });
  if (!committed.ok)
    return err(committed.error.kind === "branch_moved" ? "stale" : "git");

  const commitOid = committed.value.commitOid;
  trackPullHead(app.db, repo.id, pull.headBranch, commitOid);
  // `update-ref` runs no hooks: announce the push as a git push would be.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      updates: [{ ref: `refs/heads/${pull.headBranch}`, newOid: commitOid }],
      viaApi: true,
    },
  });
  return ok({ commitOid });
}
