/**
 * The pull that gives a build's branch its preview (#11010), and the
 * versions the branch holds. Opening the pull is a write: it happens when a
 * turn ends (`crew/conversation.ts`) and on Restore and Publish, never on a read.
 */

import type { App } from "../app.ts";
import { type ChatBuild, chatBuildOf, setBuildPull } from "../core/chat_build.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { commitLog, type Commit } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { openPull } from "./pulls.ts";

/** Most versions listed for one build. */
export const VERSIONS_MAX = 200;

export interface Version {
  readonly number: number;
  readonly oid: string;
  readonly subject: string;
  readonly date: string;
}

/** The branch's commits past the default branch, oldest first, numbered from 1. */
export async function versionsIn(app: App, repo: Repo, build: ChatBuild): Promise<Version[]> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const log = await commitLog(dir, `refs/heads/${repo.defaultBranch}..refs/heads/${build.branch}`, { limit: VERSIONS_MAX });
  if (!log.ok) return [];
  return log.value.reverse().map((c: Commit, i) => ({ number: i + 1, oid: c.oid, subject: c.subject, date: c.date }));
}

/** Open the build's pull once a version exists; the build as it stands after. */
export async function ensureBuildPull(app: App, user: User, build: ChatBuild, repo: Repo): Promise<ChatBuild> {
  if (build.pullNumber !== null || build.publishedAt !== null) return build;
  if ((await versionsIn(app, repo, build)).length === 0) return build;
  const opened = await openPull(app, user, repo, { title: `Build: ${repo.name}`, body: "Made by Talk.", baseBranch: repo.defaultBranch, headBranch: build.branch });
  if (!opened.ok) return build;
  setBuildPull(app.db, build.conversationId, opened.value.number);
  return { ...build, pullNumber: opened.value.number };
}

/** A turn ended in this conversation: if it is a build and the turn made its first version, open the pull. */
export async function buildTurnEnded(app: App, userId: string, conversationId: string): Promise<void> {
  const build = chatBuildOf(app.db, conversationId);
  const repo = build === undefined ? undefined : getRepoById(app.db, build.repoId);
  const user = getUserById(app.db, userId);
  if (build === undefined || repo === undefined || user === undefined) return;
  await ensureBuildPull(app, user, build, repo);
}
