/**
 * A pull that conflicts only in list-like docs (`LIST_DOCS`) is brought up to
 * date by the forge: the base merged into its head with both sides' lines
 * kept, one commit on the head branch. No clone, no run, no model — the
 * conflicts every landing on docs/MCP.md makes are not worth one.
 */

import type { App } from "../app.ts";
import { forgeHost, noreplyAddress } from "../core/commit_identity.ts";
import { trackPullHead, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { conflictedTree } from "../git/conflict-file.ts";
import { runGit } from "../git/env.ts";
import { mergeable, mergeBase, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { isListDoc, unionMergeFile } from "../git/union-merge.ts";
import { commitFiles } from "../git/write.ts";

/** Whether every conflicted path is one a list-merge settles. */
export const onlyListDocs = (files: readonly string[]): boolean =>
  files.length > 0 && files.every(isListDoc);

/**
 * Merge the base into the pull's head, keeping both sides of every list-doc
 * clash, when those are the only files that conflict. The commit id when the
 * head moved; undefined when this is not a pull the forge can settle, or the
 * branch moved meanwhile (the next look decides).
 */
export async function resolveListConflicts(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<string | undefined> {
  if (pull.state !== "open" || pull.mergedAt !== null) return undefined;
  if (pull.crossRepo || pull.originHeadRepo !== null || repo.origin !== null) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const head = await resolveOid(dir, `refs/heads/${pull.headBranch}`);
  const tip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
  if (head === undefined || tip === undefined) return undefined;
  // Asked of git now, not of the red that sent us: the base may have moved.
  const now = await mergeable(dir, tip, head);
  if (now.ok || now.error.kind !== "conflict" || !onlyListDocs(now.error.files)) return undefined;
  const files = now.error.files;
  const base = await mergeBase(dir, tip, head);
  const tree = await conflictedTree(dir, tip, head);
  if (base === undefined || tree === undefined) return undefined;
  const written: { path: string; content: string; mode: "100644" | "100755" }[] = [];
  for (const path of files) {
    const content = await unionMergeFile(dir, base, head, tip, path);
    const entry = await runGit(["ls-tree", tree, "--", path], { cwd: dir });
    const mode = entry.ok ? entry.value.split(" ")[0] : undefined;
    if (content === undefined || (mode !== "100644" && mode !== "100755")) return undefined;
    written.push({ path, content, mode });
  }
  const committed = await commitFiles(dir, {
    branch: pull.headBranch,
    message: `Merge ${pull.baseBranch} into ${pull.headBranch}\n\nKept both sides in ${files.join(", ")}.`,
    files: written,
    seedTree: tree,
    mergeParents: [tip],
    expectTip: head,
    author: { name: "forge", email: noreplyAddress("forge", forgeHost(app.config)) },
  });
  if (!committed.ok) return undefined;
  const commitOid = committed.value.commitOid;
  trackPullHead(app.db, repo.id, pull.headBranch, commitOid);
  // `update-ref` runs no hooks: announce the push as a git push would be.
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    payload: {
      updates: [{ ref: `refs/heads/${pull.headBranch}`, newOid: commitOid }],
      viaApi: true,
    },
  });
  return commitOid;
}
