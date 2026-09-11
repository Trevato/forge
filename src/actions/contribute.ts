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

import type { App } from "../app.ts";
import {
  findOriginFork,
  getOriginFor,
  getOriginRepo,
  mirrorOf,
  rememberOriginRepo,
  setRepoForkOf,
  type Origin,
} from "../core/origins.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import type { CommitResult } from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { fetchRefFrom } from "../origins/git-mirror.ts";
import { importIssue } from "../origins/import.ts";
import { settled, type MirrorJob } from "../origins/jobs.ts";
import { mirrorRepo, startMirror } from "../origins/mirror.ts";
import type { Provider, RemoteRepo } from "../origins/types.ts";
import type { WriteThroughError } from "../origins/write-through.ts";
import { createBranch } from "./branches.ts";
import { editFiles, type EditFile, type EditFilesError } from "./contents.ts";
import { requireUser } from "./access.ts";

// ---- forking at the origin ----

/**
 * How long to wait for a fork to exist. GitHub's docs say most forks are
 * ready "within five minutes" and are in practice ready in one or two
 * seconds; thirty is long enough for the common case and short enough that a
 * request does not hang on the pathological one.
 */
const FORK_DEADLINE_MS = 30_000;

/** Backoff between polls, in ms; the last value repeats until the deadline. */
const FORK_BACKOFF = [250, 500, 1_000, 2_000, 3_000] as const;

export type ForkOriginError =
  | "unauthorized"
  | "not_found"
  | "origin_unreachable"
  | "origin_refused"
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
): Promise<Result<ForkOriginResult, ForkOriginError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // Somebody else's connected account does not exist for you (invariant 9).
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("origin_unreachable");

  const upstream = await provider.value.getRepo(fullName);
  if (!upstream.ok)
    return err(
      upstream.error.error === "not_found" ? "not_found" : "origin_unreachable",
    );

  const found = await existingFork(
    app,
    origin,
    provider.value,
    upstream.value.fullName,
  );
  let existed = found !== undefined;
  let remote = found;

  if (remote === undefined) {
    const asked = await provider.value.forkRepo(upstream.value.fullName);
    if (!asked.ok) {
      // An origin that forks in the request itself can take longer than we
      // wait for an answer, and still have done it. Before calling that a
      // failure, look for the fork under its conventional name.
      const name = upstream.value.fullName.split("/")[1] ?? "";
      const late =
        asked.error.error === "unreachable" &&
        name !== "" &&
        origin.login !== ""
          ? await awaitFork(
              provider.value,
              `${origin.login}/${name}`,
              options.waitMs ?? FORK_DEADLINE_MS,
            )
          : undefined;
      if (
        late === undefined ||
        !late.ok ||
        !sameRepo(late.value.parent, upstream.value.fullName)
      )
        return err(
          asked.error.error === "unreachable" ||
            asked.error.error === "rate_limited"
            ? "origin_unreachable"
            : "origin_refused",
        );
      remote = late.value;
    } else {
      const ready = await awaitFork(
        provider.value,
        asked.value.fullName,
        options.waitMs ?? FORK_DEADLINE_MS,
      );
      if (!ready.ok) return ready;
      remote = ready.value;
    }
    existed = false;
  }

  rememberOriginRepo(app.db, origin.id, {
    ...remote,
    // Both forges report the parent on `getRepo`; if this one did not, we
    // know it anyway, because we are the reason the fork exists.
    parent: remote.parent ?? upstream.value.fullName,
  });

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
  const mirror = done?.repo
    ? getRepoById(app.db, done.repo.id)
    : localMirror(app, origin, remote.fullName);
  if (mirror !== undefined) setRepoForkOf(app.db, mirror.id, upstreamName);
  return ok({ remote, mirror, job, existed });
}

/**
 * The fork of `upstream` this account already has, if any. The cache is
 * asked first (it is the picker's own answer and costs nothing); failing
 * that, the conventional name is asked for directly, because a fork made
 * outside this forge is not in the cache and forking again would be wrong.
 */
async function existingFork(
  app: App,
  origin: Origin,
  provider: Provider,
  upstream: string,
): Promise<RemoteRepo | undefined> {
  const cached = findOriginFork(app.db, origin.id, upstream);
  if (cached !== undefined) {
    const fresh = await provider.getRepo(cached.fullName);
    if (fresh.ok && sameRepo(fresh.value.parent, upstream)) return fresh.value;
  }
  const name = upstream.split("/")[1] ?? "";
  if (name === "" || origin.login === "") return undefined;
  const guess = await provider.getRepo(`${origin.login}/${name}`);
  if (guess.ok && sameRepo(guess.value.parent, upstream)) return guess.value;
  return undefined;
}

const sameRepo = (a: string | null, b: string): boolean =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/** Poll until the origin admits the fork exists, or the deadline passes. */
async function awaitFork(
  provider: Provider,
  fullName: string,
  waitMs: number,
): Promise<Result<RemoteRepo, ForkOriginError>> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const found = await provider.getRepo(fullName);
    // An empty fork is still a fork; what we are waiting for is the row.
    if (found.ok) return ok(found.value);
    if (found.error.error !== "not_found")
      return err(
        found.error.error === "unreachable" ||
          found.error.error === "rate_limited"
          ? "origin_unreachable"
          : "origin_refused",
      );
    const wait =
      FORK_BACKOFF[Math.min(attempt, FORK_BACKOFF.length - 1)] ?? 3_000;
    if (Date.now() + wait > deadline) return err("fork_timeout");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
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
): Promise<Result<ContributeResult, ContributeError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, input.originId);
  if (!origin) return err("not_found");
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

  return upstream.value.permissions.push
    ? await contributeDirect(app, user.value, origin, upstream.value, {
        ...input,
        branch,
        base,
      })
    : await contributeViaFork(app, user.value, origin, upstream.value, {
        ...input,
        branch,
        base,
      });
}

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
