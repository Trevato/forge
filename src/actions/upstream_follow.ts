/**
 * Checking a followed upstream (#3442, layer 2): one `ls-remote`, a fetch
 * only when the tip moved, into `refs/upstream-follow/<branch>` — not a
 * branch, so nothing of ours moves. What it found is noted on the follow row
 * (upstream tip, commits behind).
 *
 * Layer 3, the proposal: new commits that merge cleanly into the default
 * branch are pushed as `upstream/<tip7>` at the fetched head, and one pull
 * is opened from it — or the open one is moved to it. A branch of that name
 * that is not at the fetched head was planted by someone: the check fails
 * and leaves it alone. A conflicting merge is noted as "conflict" and
 * opens nothing yet.
 *
 * The fetch is the mirror's: the host is vetted and the vetted address
 * pinned (`vettedEnv`), https and http only. A connected origin's token goes
 * only to the exact https origin it was connected at. One check runs per
 * repository at a time, whoever asks.
 */

import type { App } from "../app.ts";
import { getIssueById, updateIssueText } from "../core/issues.ts";
import { getOriginFor } from "../core/origins.ts";
import { pullForBranch, retargetPull } from "../core/pulls.ts";
import { canAdmin, canWrite, getRepoById, type Repo } from "../core/repos.ts";
import { storageStale } from "../core/storage.ts";
import {
  getFollow,
  listFollowing,
  noteCheck,
  putFollow,
  upstreamUrl,
  type UpstreamFollow,
} from "../core/upstream_follow.ts";
import { getUserById, type User } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeOid, isSafeRef } from "../git/guard.ts";
import { aheadCount, mergeable, resolveOid, writeRef } from "../git/merge.ts";
import { REMOTE_PROTOCOLS } from "../git/remote-env.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { redact, secretsIn } from "../origins/credentials.ts";
import { vettedEnv } from "../origins/git-mirror.ts";
import { migrateUrl } from "./migrate.ts";
import { openPull } from "./pulls.ts";

/** How often a following repository is checked on its own. */
export const FOLLOW_EVERY_MS = 30 * 60_000;
/** One check's whole budget: ls-remote and fetch together. */
const CHECK_TIMEOUT_MS = 120_000;

/** Where the upstream tip is staged: not a branch, so a check moves nothing of ours. */
export const stagedRef = (branch: string): string => `refs/upstream-follow/${branch}`;

export type CheckError = "off" | "nobody" | "unreadable" | "no_branch" | "git" | "busy" | "squatted";

/** What each refusal says, at every door. */
export const CHECK_REFUSALS: Record<CheckError, string> = {
  off: "Following an upstream is off for this repository.",
  nobody: "The person who turned following on can no longer write here; turn it on again.",
  unreadable: "The upstream could not be read.",
  no_branch: "The upstream has no such branch.",
  git: "Git could not read the staged upstream.",
  busy: "Already checking this upstream",
  squatted: "A branch of the proposal's name already exists and is not the upstream's head.",
};

/** What one check read. */
export interface Checked {
  readonly tip: string;
  readonly behind: number;
  /** What the check did about the commits: nothing new, opened or moved a pull, or found a conflict. */
  readonly outcome: "none" | "proposed" | "conflict";
  /** The pull carrying the proposal, when there is one. */
  readonly pull?: number;
}

/** The branch a proposal for this upstream tip is pushed to. */
export const proposalBranch = (tip: string): string => `upstream/${tip.slice(0, 7)}`;

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
    const result = await checkOnce(app, repo);
    // So an open settings page or About card updates; no address in it.
    if (result.ok || result.error !== "off")
      app.bus.append({ kind: "repo.upstream_checked", repoId: repo.id, payload: {} });
    return result;
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
  if (behind === 0) {
    noteCheck(app.db, repo.id, { at, tip: staged, behind, error: "" });
    return ok({ tip: staged, behind, outcome: "none" });
  }

  const merged = await mergeable(dir, main, staged);
  if (!merged.ok) {
    if (merged.error.kind !== "conflict") return failed("git");
    noteCheck(app.db, repo.id, { at, tip: staged, behind, error: "conflict" });
    return ok({ tip: staged, behind, outcome: "conflict" });
  }

  // The branch is ours only if it is at the fetched head, or not there yet.
  const name = proposalBranch(staged);
  const planted = await resolveOid(dir, `refs/heads/${name}`);
  if (planted !== undefined && planted !== staged) return failed("squatted");
  if (planted === undefined && !(await writeRef(dir, `refs/heads/${name}`, staged)))
    return failed("git", "The proposal's branch could not be written.");

  const text = {
    title: `Upstream: ${behind} new commit${behind === 1 ? "" : "s"} on ${follow.branch}`,
    body: `New commits from ${follow.url} (${follow.branch}), up to ${staged.slice(0, 7)}. They merge cleanly into ${repo.defaultBranch}.`,
  };
  const known = pullForBranch(app.db, repo.id, name);
  const pending = follow.pendingId === null ? undefined : getIssueById(app.db, follow.pendingId);
  const open = pending !== undefined && pending.kind === "pull" && pending.state === "open";
  let number: number;
  if (known !== undefined) {
    // This tip was proposed already, whatever came of it: nothing new.
    number = known.number;
  } else if (open) {
    // The upstream moved on: the open pull follows it instead of a second opening.
    retargetPull(app.db, pending.id, name, staged);
    await writeRef(dir, `refs/pull/${pending.number}/head`, staged);
    updateIssueText(app.db, pending.id, text);
    number = pending.number;
  } else {
    const opened = await openPull(app, by, repo, { ...text, baseBranch: repo.defaultBranch, headBranch: name });
    if (!opened.ok) return failed("git", `The proposal could not be opened: ${opened.error}`);
    noteCheck(app.db, repo.id, { at, tip: staged, behind, error: "", pendingId: opened.value.id, opened: true });
    return ok({ tip: staged, behind, outcome: "proposed", pull: opened.value.number });
  }
  noteCheck(app.db, repo.id, { at, tip: staged, behind, error: "" });
  return ok({ tip: staged, behind, outcome: "proposed", pull: number });
}

export type FollowError = "invalid_url" | "invalid_branch" | "not_found" | "unauthorized" | "forbidden";

/** What each refusal of a save says, at every door; a check's are `CHECK_REFUSALS`. */
export const FOLLOW_REFUSALS: Record<FollowError | CheckError, string> = {
  ...CHECK_REFUSALS,
  invalid_url: "The upstream is an https or http git address, with no password in it.",
  invalid_branch: "That is not a branch name git accepts.",
  not_found: "No such repository.",
  unauthorized: "Sign in first.",
  forbidden: "Only an admin of this repository follows an upstream.",
};

/** The follow row, for an admin of the repository and for nobody else. */
export function followShown(app: App, repo: Repo, actor: User | undefined): UpstreamFollow | undefined {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return undefined;
  return getFollow(app.db, repo.id);
}

/** Point a repository at an upstream and turn following on or off. Admins only. */
export function setFollowUpstream(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { readonly url: string; readonly branch: string; readonly enabled: boolean },
): Result<UpstreamFollow, FollowError> {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return err("not_found");
  const was = getFollow(app.db, repo.id);
  // Turning it off needs no address: the row keeps the last one.
  const blank = input.url.trim() === "";
  const raw = blank && was !== undefined ? was.url : input.url;
  const normal = migrateUrl(raw);
  const url = normal === undefined ? undefined : upstreamUrl(normal);
  if (url === undefined) return err("invalid_url");
  const branch = input.branch.trim() === "" ? (was?.branch ?? "main") : input.branch.trim();
  if (!isSafeRef(branch) || branch.length > 200) return err("invalid_branch");
  const saved = putFollow(app.db, {
    repoId: repo.id,
    url,
    branch,
    enabled: input.enabled,
    byId: actor.id,
    originId: was?.url === url ? was.originId : "",
  });
  app.bus.append({
    kind: "repo.upstream_follow",
    repoId: repo.id,
    actorId: actor.id,
    payload: { enabled: saved.enabled, branch: saved.branch },
  });
  return ok(saved);
}

/** "Check upstream now": an admin's, through the same claim as the clock. */
export async function checkUpstreamNow(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<Checked, FollowError | CheckError>> {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return err("not_found");
  return checkUpstream(app, repo);
}

/** The follow row as the API shows it. */
export function followJson(f: UpstreamFollow): Record<string, unknown> {
  return {
    url: f.url,
    branch: f.branch,
    enabled: f.enabled,
    checked_at: f.checkedAt,
    tip: f.tip === "" ? null : f.tip,
    behind: f.behind,
    error: f.error === "" ? null : f.error,
    pending_id: f.pendingId,
    opened: f.opened,
  };
}

/** `host/path` of an upstream, for a line of prose. */
export function upstreamLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\.git$/, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** HH:MM, UTC. */
export const clockWords = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(11, 16);
};

/** Where a following stands: what the last check read. */
export function standing(f: UpstreamFollow): string {
  if (!f.enabled) return "off";
  if (f.error !== "") return f.error === "conflict" ? `${f.behind} behind, conflicts` : "last check failed";
  if (f.checkedAt === null) return "not checked yet";
  return f.behind === 0 ? "up to date" : `${f.behind} behind`;
}

/** What "Check upstream now" found, in a sentence. */
export function checkedWords(c: Checked): string {
  if (c.outcome === "none") return "Up to date: nothing new upstream.";
  if (c.outcome === "conflict") return `${c.behind} new upstream commits conflict with the default branch.`;
  return `${c.behind} new upstream commit${c.behind === 1 ? "" : "s"} proposed${c.pull === undefined ? "" : ` in #${c.pull}`}.`;
}
