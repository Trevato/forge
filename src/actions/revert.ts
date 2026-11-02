/**
 * Take it back: land a change that undoes exactly what a shipped pull
 * merged. It never writes to the default branch itself — a branch, a
 * revert commit built as plumbing (`git/revert.ts`), and a pull whose title
 * says what it undoes, exactly like any other change a person opens. Only
 * a fresh branch and a fresh pull commit if the revert applies cleanly;
 * anything that does not land cleanly leaves nothing behind.
 */

import type { App } from "../app.ts";
import { revertOf, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import type { User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { revertCommit, type RevertError } from "../git/revert.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { createBranch, deleteBranch } from "./branches.ts";
import { openPull } from "./pulls.ts";

export type RevertPullError =
  | AccessError
  | RevertError
  | "not_shipped"
  | "mirrored"
  | "already_reverted"
  | { kind: "branch_failed"; reason: string }
  | { kind: "pull_failed"; reason: string };

export async function revertPull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  body: string = `Reverts #${pull.number}.`,
): Promise<Result<Pull, RevertPullError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (pull.repoId !== repo.id) return err("not_found");
  // Rule 1 in docs/APPS.md: the crew proposes, a person lands. Taking a
  // change back is a landing verb, not a proposing one.
  if (writer.value.kind === "agent") return err("forbidden");
  if (pull.mergedAt === null || pull.mergedOid === null)
    return err("not_shipped");
  // On a mirror the origin owns history; a local revert here would be
  // overwritten by the next sync, exactly as a local merge would.
  if (repo.origin !== null || pull.originHeadRepo !== null)
    return err("mirrored");
  if (revertOf(app.db, repo.id, pull.id) !== undefined)
    return err("already_reverted");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const onto = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (onto === undefined)
    return err({ kind: "git", message: "the default branch has no tip" });

  const built = await revertCommit(dir, {
    commitOid: pull.mergedOid,
    ontoOid: onto,
    message: `Revert "${pull.title}" (#${pull.number})`,
    author: commitIdentity(app.config, writer.value),
  });
  if (!built.ok) return built;

  // The branch name is the server's own — never taken from the request —
  // so it always says exactly what it reverts.
  const branchName = `revert-${pull.number}`;
  const branch = await createBranch(app, writer.value, repo, {
    name: branchName,
    from: built.value.commitOid,
  });
  if (!branch.ok) {
    const reason = typeof branch.error === "string" ? branch.error : "git";
    return err({ kind: "branch_failed", reason });
  }

  const opened = await openPull(app, writer.value, repo, {
    title: `Revert "${pull.title}"`,
    body,
    baseBranch: repo.defaultBranch,
    headBranch: branchName,
    revertsIssueId: pull.id,
  });
  if (!opened.ok) {
    // The branch was made for this pull and the pull did not open: take it
    // back so a refused revert leaves nothing half-made behind, the same
    // rule `editFiles` (`actions/contents.ts`) follows for the same reason.
    await deleteBranch(app, writer.value, repo, branchName);
    const reason = typeof opened.error === "string" ? opened.error : "git";
    return err({ kind: "pull_failed", reason });
  }
  return ok(opened.value);
}
