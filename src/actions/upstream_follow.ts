/**
 * Checking a followed upstream (#3442, layer 2): one `ls-remote`, a fetch
 * only when the tip moved, into `refs/upstream-follow/<branch>` — not a
 * branch, so nothing of ours moves. What it found is noted on the follow row
 * (upstream tip, commits behind). It opens nothing.
 *
 * The fetch is the mirror's: the host is vetted and the vetted address
 * pinned (`vettedEnv`), https and http only. A connected origin's token goes
 * only to the exact https origin it was connected at. One check runs per
 * repository at a time, whoever asks.
 */

import type { App } from "../app.ts";
import { getOriginFor } from "../core/origins.ts";
import { canWrite, getRepoById, type Repo } from "../core/repos.ts";
import { storageStale } from "../core/storage.ts";
import { getFollow, listFollowing, noteCheck } from "../core/upstream_follow.ts";
import { getUserById } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { aheadCount, resolveOid } from "../git/merge.ts";
import { REMOTE_PROTOCOLS } from "../git/remote-env.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { redact, secretsIn } from "../origins/credentials.ts";
import { vettedEnv } from "../origins/git-mirror.ts";

/** How often a following repository is checked on its own. */
export const FOLLOW_EVERY_MS = 30 * 60_000;
/** One check's whole budget: ls-remote and fetch together. */
const CHECK_TIMEOUT_MS = 120_000;

/** Where the upstream tip is staged: not a branch, so a check moves nothing of ours. */
export const stagedRef = (branch: string): string => `refs/upstream-follow/${branch}`;

export type CheckError = "off" | "nobody" | "unreadable" | "no_branch" | "git" | "busy";

/** What each refusal says, at every door. */
export const CHECK_REFUSALS: Record<CheckError, string> = {
  off: "Following an upstream is off for this repository.",
  nobody: "The person who turned following on can no longer write here; turn it on again.",
  unreadable: "The upstream could not be read.",
  no_branch: "The upstream has no such branch.",
  git: "Git could not read the staged upstream.",
  busy: "Already checking this upstream",
};

/** What one check read. */
export interface Checked {
  readonly tip: string;
  readonly behind: number;
}

/**
 * Whether an origin's token may travel to this upstream: only to the exact
 * https origin (scheme, host and port) the person connected. An `http://`
 * upstream on the same host is fetched anonymously.
 */
export function mayCarryCredential(upstreamUrl: string, webUrl: string): boolean {
  try {
    const up = new URL(upstreamUrl);
    return up.protocol === "https:" && up.origin === new URL(webUrl).origin;
  } catch {
    return false;
  }
}

/** Repositories with a check in flight: one at a time each, whoever asked. */
const checking = new Set<string>();

/**
 * One check, of one repository. The claim is taken before the first await,
 * so a double click and the clock never both run: the second is `busy`.
 */
export async function checkUpstream(app: App, repo: Repo): Promise<Result<Checked, CheckError>> {
  if (checking.has(repo.id)) return err("busy");
  checking.add(repo.id);
  try {
    return await checkOnce(app, repo);
  } finally {
    checking.delete(repo.id);
  }
}

/**
 * The clock's pass: every repository whose following is on and was last
 * checked more than `FOLLOW_EVERY_MS` ago, one after another. Never throws
 * into the timer; a repository busy with a person's check is skipped.
 */
export async function checkDue(app: App, now = Date.now()): Promise<number> {
  let checked = 0;
  for (const follow of listFollowing(app.db)) {
    if (follow.checkedAt !== null && now - Date.parse(follow.checkedAt) < FOLLOW_EVERY_MS) continue;
    const repo = getRepoById(app.db, follow.repoId);
    if (repo === undefined) continue;
    try {
      if ((await checkUpstream(app, repo)).ok) checked++;
    } catch (error) {
      app.log.error("upstream check failed", { repo: repo.id, error: String(error) });
    }
  }
  return checked;
}

async function checkOnce(app: App, repo: Repo): Promise<Result<Checked, CheckError>> {
  const follow = getFollow(app.db, repo.id);
  if (follow === undefined || !follow.enabled || repo.archivedAt !== null || repo.origin !== null)
    return err("off");
  const at = new Date().toISOString();
  const failed = (error: CheckError, why = ""): Result<Checked, CheckError> => {
    noteCheck(app.db, repo.id, { at, error: why || CHECK_REFUSALS[error] });
    return err(error);
  };
  const by = getUserById(app.db, follow.byId);
  if (by === undefined || !canWrite(app.db, repo, by)) return failed("nobody");

  // The credential of a private upstream: the connected origin's, scoped to
  // this one git invocation, and only when the upstream is that origin's https origin.
  let authEnv: Record<string, string> = {};
  if (follow.originId !== "") {
    const origin = getOriginFor(app.db, by.id, follow.originId);
    const provider = origin === undefined ? undefined : providerForOrigin(app, origin);
    if (origin !== undefined && provider?.ok && mayCarryCredential(follow.url, origin.webUrl))
      authEnv = await provider.value.gitAuthEnv(follow.url);
  }
  // Vetted as the mirror fetch is, and pinned to the address that passed.
  const pinned = await vettedEnv(follow.url, authEnv, REMOTE_PROTOCOLS);
  if (!pinned.ok) return failed("unreadable", pinned.error.message);
  const env = pinned.value;
  const said = (stderr: string): string =>
    redact(stderr.trim(), ...secretsIn(authEnv)).split("\n").find((l) => l.trim() !== "") ?? "";

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  const listed = await runGitCapture(
    ["ls-remote", "--", follow.url, `refs/heads/${follow.branch}`],
    { cwd: dir, env, timeoutMs: remaining() },
  );
  if (listed.code !== 0)
    return failed("unreadable", `The upstream could not be read: ${said(listed.stderr) || "no reason given"}`);
  const tip = listed.stdout.split("\t")[0]?.trim() ?? "";
  if (!isSafeOid(tip)) return failed("no_branch");

  // Fetch only when the tip moved: the staged ref is what the last fetch brought.
  const ref = stagedRef(follow.branch);
  if ((await resolveOid(dir, ref)) !== tip) {
    const fetched = await runGitCapture(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--quiet",
        "--",
        follow.url,
        `+refs/heads/${follow.branch}:${ref}`,
      ],
      { cwd: dir, env, timeoutMs: remaining() },
    );
    if (fetched.code !== 0)
      return failed("unreadable", `The upstream could not be fetched: ${said(fetched.stderr) || "no reason given"}`);
    storageStale(app, repo.ownerId);
  }
  const staged = await resolveOid(dir, ref);
  if (staged === undefined) return failed("git");
  const main = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (main === undefined) return failed("git", "The default branch has no commits yet.");
  const behind = await aheadCount(dir, main, staged);
  noteCheck(app.db, repo.id, { at, tip: staged, behind, error: "" });
  return ok({ tip: staged, behind });
}
