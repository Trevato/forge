/**
 * Taking the parent's code, for a forge that follows in `take-updates`
 * mode. Once the hourly fetch has put the parent's tip at
 * `refs/upstream/HEAD`, this puts a fast-forward, or a merge commit when git
 * merges the two without conflict, on one branch, `forge/take-updates`, and
 * opens one pull from it into the default branch (or updates the one already
 * open). The fork's check runs on it like on any pull; a person merges it.
 * It never moves the default branch, and production follows that branch.
 * A conflict changes nothing; it opens (or finds) one issue naming the files.
 */

import type { App } from "../app.ts";
import { openPull } from "../actions/pulls.ts";
import { commitIdentity, forgeHost, noreplyAddress } from "../core/commit_identity.ts";
import { createIssue, listIssues } from "../core/issues.ts";
import { pullForBranch, trackPullHead } from "../core/pulls.ts";
import { getRepo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { mergeable, mergeBase, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import type { ForgeLink } from "./chain.ts";

/** What the last check did with the parent's new commits; absent when it did nothing. */
export type Taken =
  | { readonly kind: "pull"; readonly number: number; readonly commits: number }
  | { readonly kind: "conflict"; readonly files: readonly string[]; readonly issue: number | null };

export const takeTitle = (upstream: string): string => `Take updates from ${upstream}`;

/** The one branch the parent's code is put on. */
export const TAKE_BRANCH = "forge/take-updates";

/** The all-zero old oid: the ref must not exist yet. */
const ZERO = "0".repeat(40);

/** Move the branch from `had` (absent: not there yet) to `to`; false when someone moved it meanwhile. */
export async function putBranch(dir: string, to: string, had: string | undefined): Promise<boolean> {
  return (await runGit(["update-ref", `refs/heads/${TAKE_BRANCH}`, to, had ?? ZERO], { cwd: dir })).ok;
}

/** Put what `refs/upstream/HEAD` holds on `forge/take-updates` and in a pull, or tell. Never throws. */
export async function takeFromParent(app: App, link: ForgeLink): Promise<Taken | undefined> {
  const [o, n] = link.repo.split("/") as [string, string];
  const repo = getRepo(app.db, o, n);
  if (repo === undefined) return undefined;
  const owner = getUserById(app.db, repo.ownerId);
  if (owner === undefined) return undefined;
  const dir = repoDir(app.reposRoot, o, n);
  const branch = repo.defaultBranch;
  const head = await resolveOid(dir, `refs/heads/${branch}`);
  const up = await resolveOid(dir, "refs/upstream/HEAD");
  if (head === undefined || up === undefined || head === up) return undefined;
  const base = await mergeBase(dir, head, up);
  if (base === undefined || base === up) return undefined; // the parent has nothing we lack
  const count = await runGit(["rev-list", "--count", `${head}..${up}`], { cwd: dir });
  const commits = count.ok ? Number(count.value.trim()) || 0 : 0;

  const had = await resolveOid(dir, `refs/heads/${TAKE_BRANCH}`);
  let to = up;
  if (base !== head) {
    const tree = await mergeable(dir, head, up);
    if (!tree.ok) {
      if (tree.error.kind !== "conflict") return undefined;
      return { kind: "conflict", files: tree.error.files, issue: tell(app, repo, link, tree.error.files) };
    }
    // The branch already holds this very merge: a new commit each hour would only churn the pull.
    if (had !== undefined && (await parentsOf(dir, had)) === `${head} ${up}`) to = had;
    else {
      const forge = { name: "forge", email: noreplyAddress("forge", forgeHost(app.config)) };
      const who = commitIdentity(app.config, owner);
      const made = await runGit(
        ["commit-tree", tree.value.treeOid, "-p", head, "-p", up, "-m", takeTitle(link.upstream)],
        {
          cwd: dir,
          env: {
            GIT_AUTHOR_NAME: who.name,
            GIT_AUTHOR_EMAIL: who.email,
            GIT_COMMITTER_NAME: forge.name,
            GIT_COMMITTER_EMAIL: forge.email,
          },
        },
      );
      if (!made.ok) return undefined;
      to = made.value.trim();
    }
  }

  const open = pullForBranch(app.db, repo.id, TAKE_BRANCH);
  const live = open !== undefined && open.mergedAt === null && open.state === "open" ? open : undefined;
  if (had === to && live !== undefined) return { kind: "pull", number: live.number, commits };
  // Compare-and-swap: a push to the branch since `had` was read wins, and the next check looks again.
  if (had !== to && !(await putBranch(dir, to, had))) return undefined;

  let number: number;
  if (live !== undefined) {
    trackPullHead(app.db, repo.id, TAKE_BRANCH, to);
    app.bus.append({
      kind: "pull.pushed",
      repoId: repo.id,
      actorId: owner.id,
      payload: { number: live.number, headOid: to, branch: TAKE_BRANCH },
    });
    number = live.number;
  } else {
    if (had === to && open !== undefined) return undefined; // closed unmerged and nothing new since
    const opened = await openPull(app, owner, repo, {
      title: takeTitle(link.upstream),
      body: [
        `${commits} new commit${commits === 1 ? "" : "s"} from ${link.upstream}, put on \`${TAKE_BRANCH}\`.`,
        "",
        "Nothing was changed on the default branch. Merge this pull when its check is green; it is never merged for you.",
      ].join("\n"),
      baseBranch: branch,
      headBranch: TAKE_BRANCH,
    });
    if (!opened.ok) return undefined;
    number = opened.value.number;
  }
  app.bus.append({
    kind: "forge.updates_taken",
    repoId: repo.id,
    payload: { repo: link.repo, upstream: link.upstream, from: head, to, commits, pull: number },
  });
  return { kind: "pull", number, commits };
}

/** A commit's parents, space-separated; empty when unreadable. */
async function parentsOf(dir: string, oid: string): Promise<string> {
  const r = await runGit(["rev-list", "--parents", "-n1", oid], { cwd: dir });
  return r.ok ? r.value.trim().split(" ").slice(1).join(" ") : "";
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
