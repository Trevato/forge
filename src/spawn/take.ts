/**
 * Taking the parent's code, for a forge that follows in `take-updates`
 * mode. Once the hourly fetch has put the parent's tip at
 * `refs/upstream/HEAD`, this moves the forge's own default branch: a
 * fast-forward, or a merge commit when git merges the two without conflict.
 * A conflict changes nothing; it opens (or finds) one issue naming the files
 * for the people here to settle. It never deploys: production follows main
 * as it always did.
 */

import type { App } from "../app.ts";
import { commitIdentity, forgeHost, noreplyAddress } from "../core/commit_identity.ts";
import { createIssue, listIssues } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { mergeable, mergeBase, merge, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import type { ForgeLink } from "./chain.ts";

/** What the last check did with the parent's new commits; absent when it did nothing. */
export type Taken =
  | { readonly kind: "took"; readonly commits: number; readonly merged: boolean; readonly to: string }
  | { readonly kind: "conflict"; readonly files: readonly string[]; readonly issue: number | null };

export const takeTitle = (upstream: string): string => `Take updates from ${upstream}`;

/** Take what `refs/upstream/HEAD` holds into the forge's default branch, or tell. Never throws. */
export async function takeFromParent(app: App, link: ForgeLink): Promise<Taken | undefined> {
  const [o, n] = link.repo.split("/") as [string, string];
  const repo = getRepo(app.db, o, n);
  if (repo === undefined) return undefined;
  const dir = repoDir(app.reposRoot, o, n);
  const branch = repo.defaultBranch;
  const head = await resolveOid(dir, `refs/heads/${branch}`);
  const up = await resolveOid(dir, "refs/upstream/HEAD");
  if (head === undefined || up === undefined || head === up) return undefined;
  const base = await mergeBase(dir, head, up);
  if (base === undefined || base === up) return undefined; // the parent has nothing we lack
  const count = await runGit(["rev-list", "--count", `${head}..${up}`], { cwd: dir });
  const commits = count.ok ? Number(count.value.trim()) || 0 : 0;

  let to = up;
  let merged = false;
  if (base === head) {
    const moved = await runGit(["update-ref", `refs/heads/${branch}`, up, head], { cwd: dir });
    if (!moved.ok) return undefined; // pushed to meanwhile: the next check looks again
  } else {
    const tree = await mergeable(dir, head, up);
    if (!tree.ok) {
      if (tree.error.kind !== "conflict") return undefined;
      return { kind: "conflict", files: tree.error.files, issue: tell(app, repo, link, tree.error.files) };
    }
    const owner = getUserById(app.db, repo.ownerId);
    const author = {
      name: "forge",
      email: noreplyAddress("forge", forgeHost(app.config)),
    };
    const landed = await merge(dir, {
      baseBranch: branch,
      baseOid: head,
      headOid: up,
      strategy: "merge",
      message: takeTitle(link.upstream),
      author: owner === undefined ? author : commitIdentity(app.config, owner),
      committer: author,
      treeOid: tree.value.treeOid,
    });
    if (!landed.ok) return undefined;
    to = landed.value.mergeOid;
    merged = true;
  }
  const taken: Taken = { kind: "took", commits, merged, to };
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    payload: {
      updates: [{ ref: `refs/heads/${branch}`, oldOid: head, newOid: to }],
      followed: link.upstream,
      merged,
    },
  });
  app.bus.append({
    kind: "forge.updates_taken",
    repoId: repo.id,
    payload: { repo: link.repo, upstream: link.upstream, from: head, to, commits, merged },
  });
  return taken;
}

/** The one open issue naming the conflicting files; the number, or null when nobody may open it. */
function tell(app: App, repo: NonNullable<ReturnType<typeof getRepo>>, link: ForgeLink, files: readonly string[]): number | null {
  const title = takeTitle(link.upstream);
  const open = listIssues(app.db, repo.id, { sealed: true, state: "open", limit: 200 }).find((i) => i.title === title);
  if (open !== undefined) return open.number;
  const owner = getUserById(app.db, repo.ownerId);
  if (owner === undefined || owner.kind !== "user") return null;
  const made = createIssue(app.db, {
    repoId: repo.id,
    authorId: owner.id,
    title,
    body: [
      `This forge takes updates from ${link.upstream}, and they do not merge cleanly: ${files.length === 1 ? "one file" : `${files.length} files`} changed on both sides: ${files.join(", ")}.`,
      "",
      "Nothing on the default branch was changed. The parent's code is fetched at `refs/upstream/HEAD`; merge it into a branch, settle those files, and propose the result as a pull.",
    ].join("\n"),
  });
  if (!made.ok) return null;
  app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: owner.id, payload: { number: made.value.number } });
  return made.value.number;
}
