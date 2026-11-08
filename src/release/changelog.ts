/**
 * The changelog's data: the last 30 `Release <version>: …` commits on the
 * forge's own default branch, newest first, each with the pulls its subject
 * names (`core/release_subject.ts` reads the subject). One bounded log read,
 * kept per head oid so a request between releases costs only a `rev-parse`.
 * Only a public `FORGE_REPO` is read.
 */

import type { App } from "../app.ts";
import { publicForgeRepo } from "../core/forge_repo.ts";
import type { Repo } from "../core/repos.ts";
import { parseReleaseSubject, type ReleasePull } from "../core/release_subject.ts";
import { runGit } from "../git/env.ts";
import { commitLog } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";

export const CHANGELOG_LIMIT = 30;

export interface ReleaseEntry {
  readonly version: string;
  readonly date: string;
  readonly pulls: readonly ReleasePull[];
}

const cache = new Map<string, { oid: string; entries: ReleaseEntry[] }>();

/** The newest releases on `branch`, read once per head oid. */
export async function readChangelog(dir: string, branch: string): Promise<ReleaseEntry[]> {
  const head = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: dir });
  if (!head.ok) return [];
  const cached = cache.get(dir);
  if (cached?.oid === head.value) return cached.entries;
  const log = await commitLog(dir, head.value, { limit: CHANGELOG_LIMIT, grep: "^Release [0-9]+\\.[0-9]+\\.[0-9]+: " });
  if (!log.ok) return [];
  const entries: ReleaseEntry[] = [];
  for (const commit of log.value) {
    const release = parseReleaseSubject(commit.subject);
    if (release !== undefined) entries.push({ version: release.version, date: commit.date, pulls: release.pulls });
  }
  cache.set(dir, { oid: head.value, entries });
  return entries;
}

/** What the page and the terminal both show: the repository and its newest releases. */
export async function forgeChangelog(
  app: App,
): Promise<{ repo: Repo; entries: ReleaseEntry[] } | undefined> {
  const repo = publicForgeRepo(app);
  if (repo === undefined) return undefined;
  const entries = await readChangelog(repoDir(app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch);
  return { repo, entries };
}
