/**
 * The fork flow: contributing to a repository you cannot push to.
 *
 * This is the workflow the whole origins layer was built for, and it is one
 * intention — *grab their repo, branch, edit, propose it back* — so it is one
 * call. Split across five round trips it becomes five half-finished states:
 * a fork with no mirror, a mirror with no branch, a branch with no commit, a
 * commit nobody proposed.
 *
 * **Where the work happens.** You cannot commit to a repository you cannot
 * push to, so the workbench is a mirror of *your fork* of it. The branch is
 * created there, the commit lands there, and both travel to your fork at the
 * origin through the ordinary push-through path (`actions/branches.ts`) — the
 * origin is truth for a mirror, so nothing moves locally that the origin did
 * not take first. Only then is the pull opened, **on the upstream**, with the
 * `owner:branch` head form both forges use for a cross-repository proposal.
 *
 * **The branch starts from the upstream, not from the fork.** A fork made
 * months ago is a snapshot; committing on top of it produces a pull full of
 * changes somebody already merged. So the upstream's base ref is fetched
 * into the fork's mirror first (`fetchRefFrom`) and the branch starts from
 * that commit — the same thing a person does with `git fetch upstream`.
 *
 * **Push rights change nothing but the shape.** If the origin says you can
 * push to the repository itself, no fork is made and the branch is created
 * on the upstream's own mirror. Same call, same result, one fewer repository
 * in the world.
 *
 * **Forking is asynchronous.** GitHub answers `POST /forks` with 202 and a
 * repository that does not exist yet; asking for it immediately is a 404.
 * `forkOrigin` polls until it appears, which is why it takes a deadline
 * rather than assuming.
 */

import { requireVerified } from "./verify.ts";
import type { App } from "../app.ts";
import {
  getOriginFor,
  getOriginRepo,
  mirrorOf,
  rememberOriginRepo,
  setRepoForkOf,
  type Origin,
} from "../core/origins.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { deleteRepo as destroyRepo, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import type { CommitResult } from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin, writesPaused } from "../origins/credential.ts";
import { fetchRefFrom } from "../origins/git-mirror.ts";
import { importIssue } from "../origins/import.ts";
import { settled, type MirrorJob } from "../origins/jobs.ts";
import { mirrorRepo, startMirror } from "../origins/mirror.ts";
import { ensureFork, forkDeadline } from "../origins/fork-route.ts";

import { denied } from "../origins/operator.ts";
import type { Provider, RemoteRepo } from "../origins/types.ts";
import type { WriteThroughError } from "../origins/write-through.ts";
import { createBranch } from "./branches.ts";
import { editFiles, type EditFile, type EditFilesError } from "./contents.ts";
import { requireUser } from "./access.ts";

export { forkDeadline };

// ---- forking at the origin ----

export type ForkOriginError =
  | "unauthorized"
  | "unverified"
  | "not_found"
  | "origin_unreachable"
  | "origin_refused"
  /** The connection is not verified against the operator's rules yet. */
  | "origin_paused"
  /** The origin took the request and the fork never appeared in time. */
  | "fork_timeout";

export interface ForkOriginResult {
  /** The fork as the origin describes it. */
  readonly remote: RemoteRepo;
  /** The local mirror of it, when one exists (or was awaited). */
  readonly mirror: Repo | undefined;
  /** The mirror job, when one was started rather than awaited. */
  readonly job: MirrorJob | undefined;
  /** True when the fork already existed and nothing was created. */
  readonly existed: boolean;
}

export interface ForkOriginOptions {
  /**
   * What to do about a local copy. `job` starts one and returns immediately
   * (what an API answering 202 wants); `wait` runs it to completion (what
   * `contribute` needs, since it is about to commit into it); `none` records
   * the fork and leaves it at the origin. @default "job"
   */
  readonly mirror?: "job" | "wait" | "none";
  /** Override the fork-appears deadline. @default 30 000 ms */
  readonly waitMs?: number;
}

/**
 * Fork a repository at the origin, into the connected account.
 *
 * Idempotent on purpose: a fork of this upstream that the account already
 * has is returned as-is rather than asked for again. GitHub answers a repeat
 * `POST /forks` with the existing fork and Forgejo answers 409, so the check
 * has to happen here for both to behave alike.
 */
export async function forkOrigin(
  app: App,
  actor: User | undefined,
  originId: string,
  fullName: string,
  options: ForkOriginOptions = {},
): Promise<Result<ForkOriginResult, ForkOriginError | "unverified">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  // Somebody else's connected account does not exist for you (invariant 9).
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  if (writesPaused(app, origin.id) !== undefined) return err("origin_paused");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("origin_unreachable");

  const upstream = await provider.value.getRepo(fullName);
  if (!upstream.ok)
    return err(
      upstream.error.error === "not_found" ? "not_found" : "origin_unreachable",
    );

  const forked = await ensureFork(
    app,
    origin,
    provider.value,
    upstream.value.fullName,
    options.waitMs ?? forkDeadline.ms,
  );
  if (!forked.ok) return forked;
  const { remote, existed } = forked.value;

  app.bus.append({
    kind: "repo.forked",
    actorId: user.value.id,
    payload: {
      via: "origin",
      origin: origin.webUrl,
      parent: upstream.value.fullName,
      fullName: remote.fullName,
      existed,
    },
  });

  const upstreamName = upstream.value.fullName;
  const existing = localMirror(app, origin, remote.fullName);
  if (existing !== undefined) {
    setRepoForkOf(app.db, existing.id, upstreamName);
    return ok({ remote, mirror: existing, job: undefined, existed });
  }
  if ((options.mirror ?? "job") === "none")
    return ok({ remote, mirror: undefined, job: undefined, existed });

  const job = startMirror(app, user.value, origin, remote.fullName);
  if ((options.mirror ?? "job") === "job") {
    // The row that remembers "this is my fork of theirs" is written when the
    // mirror finishes, which is after this call returns. Detached, and
    // swallowed: it is an index field, and a lost one costs one extra
    // `getRepo` on the next contribute, never a wrong answer.
    void settled(job.id)
      .then((done) => {
        if (done?.repo) setRepoForkOf(app.db, done.repo.id, upstreamName);
      })
      .catch(() => {});
    return ok({ remote, mirror: undefined, job, existed });
  }

  const done = await settled(job.id);
  // A clone that failed leaves an empty repository behind, which is right for
  // a mirror someone asked for (they can retry it) and wrong for a workbench
  // nobody will see: the work cannot start, so none of it stays.
  if (done?.stage === "failed" && done.repo !== undefined) {
    await destroyRepo(app.db, app.reposRoot, done.repo);
    return ok({ remote, mirror: undefined, job, existed });
  }
  const mirror = done?.repo
    ? getRepoById(app.db, done.repo.id)
    : localMirror(app, origin, remote.fullName);
  if (mirror !== undefined) setRepoForkOf(app.db, mirror.id, upstreamName);
  return ok({ remote, mirror, job, existed });
}

/** The local mirror of a remote repo at this origin, or undefined. */
function localMirror(
  app: App,
  origin: Origin,
  fullName: string,
): Repo | undefined {
  const cached = getOriginRepo(app.db, origin.id, fullName);
  const repoId = cached?.mirroredAs ?? mirrorOf(app.db, origin.id, fullName);
  return repoId === undefined || repoId === null
    ? undefined
    : getRepoById(app.db, repoId);
}

// ---- contributing ----

export interface ContributeInput {
  readonly originId: string;
  /** `owner/name` of the UPSTREAM repository at the origin. */
  readonly fullName: string;
  /** The branch the work lands on, in the fork. */
  readonly branch: string;
  /** The upstream branch it starts from and targets. @default the default */
  readonly base?: string;
  readonly message?: string;
  readonly files: readonly EditFile[];
  /** Open the pull upstream when the commit lands. */
  readonly openPull?: { title: string; body?: string };
}

export interface ContributedPull {
  readonly number: number;
  readonly htmlUrl: string;
  /** The imported row, when the upstream is mirrored here too. */
  readonly local?: Pull;
}

export interface ContributeResult {
  /** Where the branch landed: the fork's mirror, or the upstream's. */
  readonly fork: Repo;
  /** The fork at the origin, `owner/name` — absent on the direct path. */
  readonly forkFullName?: string;
  readonly branch: string;
  readonly commit: CommitResult;
  readonly pull?: ContributedPull;
  /** `fork` when a fork was needed; `direct` when push rights sufficed. */
  readonly via: "fork" | "direct";
}

export type ContributeError =
  | ForkOriginError
  | WriteThroughError
  | "invalid_branch"
  | "unknown_base"
  /** The workbench could not be created: the mirror failed. */
  | "mirror_failed"
  | { kind: "edit_failed"; reason: EditFilesError }
  /** The commit landed; only the proposal did not open. */
  | { kind: "pull_failed"; reason: string; commit: CommitResult };

/**
 * Grab a repository, branch, edit, propose it back — as one call.
 *
 * Everything that can be refused up front is refused up front, and the one
 * step that can fail after the commit has landed is opening the pull, which
 * carries the commit with it rather than pretending nothing happened (the
 * same contract `editFiles` keeps).
 */
export async function contribute(
  app: App,
  actor: User | undefined,
  input: ContributeInput,
): Promise<Result<ContributeResult, ContributeError | "unverified">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  const origin = getOriginFor(app.db, user.value.id, input.originId);
  if (!origin) return err("not_found");
  if (writesPaused(app, origin.id) !== undefined) return err("origin_paused");
  const branch = input.branch.trim();
  if (!isSafeRef(branch) || branch.startsWith("refs/"))
    return err("invalid_branch");

  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("origin_unreachable");
  const upstream = await provider.value.getRepo(input.fullName);
  if (!upstream.ok)
    return err(
      upstream.error.error === "not_found" ? "not_found" : "origin_unreachable",
    );
  rememberOriginRepo(app.db, origin.id, upstream.value);

  const base = (input.base ?? "").trim() || upstream.value.defaultBranch;
  if (!isSafeRef(base)) return err("unknown_base");
  // A base the upstream does not have is refused here, before a fork, a
  // branch or a commit exists. The default branch is the origin's own word.
  if (base !== upstream.value.defaultBranch) {
    const listed = await provider.value.listBranches(upstream.value.fullName);
    if (!listed.ok) return err("origin_unreachable");
    if (!listed.value.some((b) => b.name === base)) return err("unknown_base");
  }

  // Push rights decide the shape — except on a repository the operator
  // protects, which is never pushed to from here: always the fork.
  const direct =
    upstream.value.permissions.push && !denied(origin, upstream.value.fullName);
  if (direct) {
    const tried = await contributeDirect(app, user.value, origin, upstream.value, {
      ...input,
      branch,
      base,
    });
    // A forge's JSON carries no rights, so push is assumed and tried. Its
    // refusal means this account has none there: the way left is its own fork.
    if (tried.ok || origin.software !== "forge" || !refusedAtOrigin(tried.error)) return tried;
  }
  return await contributeViaFork(app, user.value, origin, upstream.value, {
    ...input,
    branch,
    base,
  });
}

/** The origin said no to the branch or commit itself, not to anything here. */
const refusedAtOrigin = (error: ContributeError): boolean =>
  typeof error === "object" && error.kind === "edit_failed" && JSON.stringify(error.reason).includes("origin_refused");

type Resolved = ContributeInput & { branch: string; base: string };

/**
 * The push-rights path. No fork is made: the branch is created on the
 * upstream's own mirror and travels to the upstream through push-through,
 * exactly as any other branch on a mirror does.
 */
async function contributeDirect(
  app: App,
  actor: User,
  origin: Origin,
  upstream: RemoteRepo,
  input: Resolved,
): Promise<Result<ContributeResult, ContributeError>> {
  const workbench = await workbenchFor(app, actor, origin, upstream.fullName);
  if (!workbench.ok) return workbench;
  const repo = workbench.value;

  const edited = await editFiles(app, actor, repo, {
    newBranch: input.branch,
    base: input.base,
    files: input.files,
    ...(input.message === undefined ? {} : { message: input.message }),
  });
  if (!edited.ok) return err({ kind: "edit_failed", reason: edited.error });

  if (input.openPull === undefined)
    return ok({
      fork: repo,
      branch: input.branch,
      commit: edited.value.commit,
      via: "direct",
    });

  const opened = await openUpstreamPull(app, actor, origin, upstream, {
    title: input.openPull.title,
    body: input.openPull.body ?? "",
    base: input.base,
    head: input.branch,
  });
  if (!opened.ok)
    return err({
      kind: "pull_failed",
      reason: opened.error,
      commit: edited.value.commit,
    });
  return ok({
    fork: repo,
    branch: input.branch,
    commit: edited.value.commit,
    pull: opened.value,
    via: "direct",
  });
}

/** The no-push-rights path: fork, commit in the fork, propose upstream. */
async function contributeViaFork(
  app: App,
  actor: User,
  origin: Origin,
  upstream: RemoteRepo,
  input: Resolved,
): Promise<Result<ContributeResult, ContributeError>> {
  const forked = await forkOrigin(
    app,
    actor,
    origin.id,
    upstream.fullName,
    // The next thing this function does is commit into it, so the mirror is
    // not optional and not something to watch — it is awaited.
    { mirror: "wait" },
  );
  if (!forked.ok) return forked;
  const fork = forked.value.mirror;
  if (fork === undefined) return err("mirror_failed");

  const dir = repoDir(app.reposRoot, fork.ownerName, fork.name);

  // Start from the UPSTREAM's base, not the fork's copy of it: a fork made
  // months ago would otherwise propose a diff full of merged work.
  let startPoint = input.base;
  if (upstream.cloneUrl !== "") {
    const authEnv = await adapterFor(app, origin)?.gitAuthEnv(
      upstream.cloneUrl,
    );
    if (authEnv !== undefined && Object.keys(authEnv).length > 0) {
      const tip = await fetchRefFrom(
        dir,
        upstream.cloneUrl,
        `refs/heads/${input.base}`,
        authEnv,
      );
      // A private upstream we cannot fetch, or a base that is not there, is
      // not fatal: the fork's own copy of the branch is the fallback, and it
      // is what a person with a stale fork would have used anyway.
      if (tip.ok) startPoint = tip.value;
    }
  }

  const created = await createBranch(app, actor, fork, {
    name: input.branch,
    from: startPoint,
  });
  // A branch already there is the retry case, not a failure: the caller
  // asked for these files on this branch, and that is still what happens.
  if (!created.ok && created.error !== "exists")
    return err({
      kind: "edit_failed",
      reason: { kind: "branch_failed", reason: created.error },
    });

  const edited = await editFiles(app, actor, fork, {
    branch: input.branch,
    files: input.files,
    ...(input.message === undefined ? {} : { message: input.message }),
  });
  if (!edited.ok) return err({ kind: "edit_failed", reason: edited.error });

  const forkOwner = forked.value.remote.owner;
  if (input.openPull === undefined)
    return ok({
      fork,
      forkFullName: forked.value.remote.fullName,
      branch: input.branch,
      commit: edited.value.commit,
      via: "fork",
    });

  const opened = await openUpstreamPull(app, actor, origin, upstream, {
    title: input.openPull.title,
    body: input.openPull.body ?? "",
    base: input.base,
    // The cross-repository head form. Both forges take it; it is the only
    // way to say "this branch, in that repository".
    head: `${forkOwner}:${input.branch}`,
  });
  if (!opened.ok)
    return err({
      kind: "pull_failed",
      reason: opened.error,
      commit: edited.value.commit,
    });
  return ok({
    fork,
    forkFullName: forked.value.remote.fullName,
    branch: input.branch,
    commit: edited.value.commit,
    pull: opened.value,
    via: "fork",
  });
}

/**
 * Open the pull on the upstream, through the provider, and import it if we
 * hold a mirror of that upstream. The pull belongs to the origin either way
 * — a local row for it is an index, and its absence costs only the link.
 */
async function openUpstreamPull(
  app: App,
  actor: User,
  origin: Origin,
  upstream: RemoteRepo,
  input: { title: string; body: string; base: string; head: string },
): Promise<Result<ContributedPull, string>> {
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("origin_unreachable");
  const title = input.title.trim();
  if (title === "") return err("empty_title");
  const created = await provider.value.createPull(upstream.fullName, {
    title,
    body: input.body,
    base: input.base,
    head: input.head,
  });
  if (!created.ok)
    return err(
      created.error.error === "unreachable" ||
        created.error.error === "rate_limited"
        ? "origin_unreachable"
        : "origin_refused",
    );

  const mirror = localMirror(app, origin, upstream.fullName);
  if (mirror === undefined)
    return ok({ number: created.value.number, htmlUrl: created.value.htmlUrl });

  importIssue(
    { db: app.db, repoId: mirror.id, actorId: actor.id },
    created.value,
  );
  app.bus.append({
    kind: "pull.opened",
    repoId: mirror.id,
    actorId: actor.id,
    payload: { number: created.value.number, via: "origin" },
  });
  const local = getPull(app.db, mirror.id, created.value.number);
  return ok({
    number: created.value.number,
    htmlUrl: created.value.htmlUrl,
    ...(local === undefined ? {} : { local }),
  });
}

/** A local mirror of `fullName`, mirroring it now if we do not hold one. */
async function workbenchFor(
  app: App,
  actor: User,
  origin: Origin,
  fullName: string,
): Promise<Result<Repo, ContributeError>> {
  const existing = localMirror(app, origin, fullName);
  if (existing !== undefined) return ok(existing);
  const mirrored = await mirrorRepo(app, actor, origin, fullName);
  if (!mirrored.ok)
    return err(mirrored.error === "not_found" ? "not_found" : "mirror_failed");
  return ok(mirrored.value.repo);
}

/** The adapter for this origin, or undefined when its credential is gone. */
function adapterFor(app: App, origin: Origin): Provider | undefined {
  const resolved = providerForOrigin(app, origin);
  return resolved.ok ? resolved.value : undefined;
}
