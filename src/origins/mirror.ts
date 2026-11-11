/**
 * Bringing a repository in. A mirror is an ordinary local repo — same bare
 * directory, same hooks, same access checks — that happens to know where it
 * came from. Nothing downstream needs a special case; `repo.origin` is the
 * only difference, and it is what makes writes go out before they land.
 *
 * Order matters, and it is the same ordering `createRepo` already keeps: the
 * git directory becomes durable before the row that references it, so a
 * visible repo is always a clonable one. Here that extends one step further —
 * the row exists before the first fetch, because a fetch that fails should
 * leave a mirror you can retry, not a half-created nothing.
 */

import { lacks, NOT_A_MEMBER } from "../core/roles.ts";
import type { App } from "../app.ts";
import {
  getOriginRepo,
  linkRepoToOrigin,
  rememberOriginRepo,
  type Origin,
} from "../core/origins.ts";
import { storageLimitMessage, storageRefusal } from "../core/storage.ts";
import { createRepo, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeName, isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { bustOrigin } from "../view/cache.ts";
import { providerForOrigin } from "./credential.ts";
import { repositoryLimitMessage, repositoryLimitRefusal } from "../actions/repos.ts";
import { redact, safeRemoteUrl } from "./credentials.ts";
import { adoptDefaultBranch, configureMirror } from "./git-mirror.ts";
import { advance, createJob, runningJob, type MirrorJob } from "./jobs.ts";
import { syncOrigin } from "./sync.ts";
import type { RemoteRepo } from "./types.ts";

export type MirrorError =
  | "not_member"
  | "not_found"
  | "invalid_name"
  | "name_taken"
  | "already_mirrored"
  | "git_init_failed"
  | "unreachable"
  | "repository_limit"
  | "storage_limit";

export interface MirrorResult {
  readonly repo: Repo;
  readonly remote: RemoteRepo;
  /**
   * What went wrong during the first import, or "" when it was clean. The
   * repo exists either way — a mirror whose fetch failed is one you can
   * retry, not a half-created nothing — but a caller with a screen has to
   * be able to say so.
   */
  readonly error: string;
}

/**
 * Mirror `fullName` from `origin` into the actor's namespace.
 *
 * Visibility follows the origin's, and it follows it on every later sync too
 * — a repo flipped to private upstream must not stay readable here. An
 * `internal` Forgejo repo has no local analogue and becomes private: never
 * silently widen a visibility on import.
 */
/** The forge's waits between tries of a new mirror's first fetch. */
export const FIRST_FETCH_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * How long to wait between tries of a new mirror's first fetch, and how the
 * wait is spent. Mutable so a test that wants a failure now can have it now,
 * and so a test can make the wait the thing it is waiting for (the origin
 * finishing the repository) instead of racing a clock against it (#541); the
 * forge keeps the defaults, and a test that changes them puts back what it
 * found.
 */
export const firstFetchRetry: {
  ms: readonly number[];
  wait: (ms: number) => Promise<void>;
} = {
  ms: FIRST_FETCH_RETRY_MS,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function mirrorRepo(
  app: App,
  actor: User,
  origin: Origin,
  fullName: string,
  name?: string,
  job?: string,
): Promise<Result<MirrorResult, MirrorError>> {
  const stage = (patch: Parameters<typeof advance>[1]): void => {
    if (job !== undefined) advance(job, patch);
  };
  // A mirror is a repository of one's own, made here by the core: a guest has none.
  if (lacks(app.db, actor, "make_it_yours")) return err("not_member");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("not_found");

  const fetched = await provider.value.getRepo(fullName);
  if (!fetched.ok)
    return err(
      fetched.error.error === "not_found" ? "not_found" : "unreachable",
    );
  const remote = fetched.value;
  // Everything in `remote` is the origin's word, and two of its fields become
  // git arguments: the clone URL (a remote) and the default branch (an
  // `--initial-branch`). Both are checked here, before a row or a directory
  // exists, so a hostile answer is an ordinary refusal — never a half-made
  // mirror and never a `defect` thrown out of `initBareRepo`.
  if (remote.cloneUrl === "" || safeRemoteUrl(remote.cloneUrl) === undefined)
    return err("unreachable");
  const defaultBranch = isSafeRef(remote.defaultBranch)
    ? remote.defaultBranch
    : "main";

  // Cache the picker row first: it is where the clone URL lives, and the
  // sync pass reads it back from there.
  rememberOriginRepo(app.db, origin.id, remote);
  const already = getOriginRepo(app.db, origin.id, remote.fullName);
  if (already?.mirroredAs != null) {
    // Its first fetch failed (the origin went down part way): the repository
    // is there with nothing in it yet, and asking again is the retry.
    const failed = getRepoById(app.db, already.mirroredAs);
    if (!failed?.origin?.fetchError) return err("already_mirrored");
    const again = await syncOrigin(app, origin, {
      initial: true,
      onlyRepoId: failed.id,
      ...(job === undefined ? {} : { onProgress: (stageName, detail) => stage({ stage: stageName, detail }) }),
    });
    await adoptDefaultBranch(repoDir(app.reposRoot, failed.ownerName, failed.name), defaultBranch);
    return ok({ repo: getRepoById(app.db, failed.id)!, remote, error: again.error });
  }

  const wanted = name ?? remote.name;
  const chosen = availableName(app, actor.id, wanted, origin);
  if (chosen === undefined) return err("name_taken");

  // A mirror is a repository the account owns: the repositories limit asks
  // here as it does at create and fork (#2093).
  if (repositoryLimitRefusal(app, actor) !== undefined) return err("repository_limit");
  if ((await storageRefusal(app, actor, actor.id)) !== undefined) return err("storage_limit");

  const created = await createRepo(app.db, app.reposRoot, {
    ownerId: actor.id,
    name: chosen,
    // A read-only origin's mirror is private to its owner (#10520).
    visibility: remote.private || origin.readOnly ? "private" : "public",
    description: remote.description,
    defaultBranch,
  });
  if (!created.ok) return err(created.error);

  linkRepoToOrigin(app.db, created.value.id, {
    originId: origin.id,
    fullName: remote.fullName,
    remoteId: remote.remoteId,
    htmlUrl: remote.htmlUrl,
  });

  const dir = repoDir(
    app.reposRoot,
    created.value.ownerName,
    created.value.name,
  );
  const configured = await configureMirror(dir, remote.cloneUrl);
  if (!configured.ok) return err("unreachable");

  app.bus.append({
    kind: "repo.mirrored",
    repoId: created.value.id,
    actorId: actor.id,
    payload: {
      origin: origin.webUrl,
      fullName: remote.fullName,
      htmlUrl: remote.htmlUrl,
    },
  });

  // The first pass is the import: one summary event, not one per row. Its
  // stages are the job's stages — there is only one place that knows how far
  // an import has got, and it is the import.
  const sync = () =>
    syncOrigin(app, origin, {
      initial: true,
      onlyRepoId: created.value.id,
      ...(job === undefined
        ? {}
        : {
            onProgress: (stageName, detail) =>
              stage({ stage: stageName, detail }),
          }),
    });
  let report = await sync();
  // A repository the origin has only just made — a fork, most often — can
  // exist in its API before its git answers. The first fetch is tried again
  // a few times before it is called a failure, and the job says so.
  for (const wait of firstFetchRetry.ms) {
    if (report.error === "") break;
    stage({
      stage: "fetching",
      detail: `the origin has not finished making it; trying again in ${Math.round(wait / 1000)}s`,
    });
    await firstFetchRetry.wait(wait);
    report = await sync();
  }

  await adoptDefaultBranch(dir, defaultBranch);

  return ok({
    repo: getRepoById(app.db, created.value.id)!,
    remote,
    error: report.error,
  });
}

/**
 * Mirror in the background, and say where it has got to.
 *
 * The result is the job, immediately: the caller has something to render
 * before a single object has moved. A second start for the same remote joins
 * the running job rather than beginning a second clone into the same
 * namespace — a double-click must not produce `widgets` and `widgets-2`.
 *
 * Nothing here throws. A failure lands in the job (and, once the repo row
 * exists, in `fetch_error`) because this runs detached from any request and
 * a rejected floating promise would take the process with it.
 */
export function startMirror(
  app: App,
  actor: User,
  origin: Origin,
  fullName: string,
  name?: string,
): MirrorJob {
  const running = runningJob(origin.id, fullName);
  if (running !== undefined) return running;

  const job = createJob(origin.id, fullName);
  void (async () => {
    try {
      const result = await mirrorRepo(
        app,
        actor,
        origin,
        fullName,
        name,
        job.id,
      );
      if (!result.ok) {
        advance(job.id, {
          stage: "failed",
          detail: "",
          error:
            result.error === "repository_limit"
              ? `Not mirrored: ${repositoryLimitMessage(app, actor)}.`
              : result.error === "storage_limit"
                ? `Not mirrored: ${storageLimitMessage(app, actor.id)}.`
                : mirrorMessage(result.error),
        });
        return;
      }
      // The mirror is now the truth for this remote, and anything the browse
      // cache holds for it predates the import.
      bustOrigin(origin.id, fullName);
      if (result.value.error !== "") {
        // The repository exists and the next sync will retry; what failed is
        // still a failure, and it belongs where somebody will see it (it is
        // in `fetch_error` too).
        advance(job.id, {
          stage: "failed",
          detail: "",
          repo: result.value.repo,
          error: `Fetching from the origin failed: ${
            redact(result.value.error)
              .split("\n")
              .find((l) => l.trim() !== "") ?? "no reason given"
          }`,
        });
        return;
      }
      advance(job.id, {
        stage: "done",
        detail: `mirrored as ${result.value.repo.ownerName}/${result.value.repo.name}`,
        repo: result.value.repo,
      });
    } catch (error) {
      // A surprise below (a vanished directory, a killed git) is this job's
      // failure and nobody else's.
      advance(job.id, {
        stage: "failed",
        detail: "",
        error: redact(String(error)),
      });
    }
  })();
  return job;
}

/** A mirror refusal in words a person can act on. */
export function mirrorMessage(error: MirrorError): string {
  switch (error) {
    case "not_member":
      return NOT_A_MEMBER;
    case "not_found":
      return "the origin has no such repository, or this account cannot see it";
    case "invalid_name":
      return "that name is not one this forge can use";
    case "name_taken":
      return "you already have a repository by every name we tried";
    case "already_mirrored":
      return "this repository is already mirrored here";
    case "git_init_failed":
      return "the local repository could not be created";
    case "unreachable":
      return "the origin could not be reached";
    case "repository_limit":
      return "this account is at the forge's repositories limit";
    case "storage_limit":
      return "this account is at the forge's storage limit";
  }
}

/**
 * A free local name. A collision gets the origin's host appended — one
 * `app` from GitHub and another from Codeberg become `app` and
 * `app-codeberg`, which is how a person would have named them anyway.
 */
function availableName(
  app: App,
  ownerId: string,
  wanted: string,
  origin: Origin,
): string | undefined {
  const candidates = [wanted, `${wanted}-${hostLabel(origin.webUrl)}`];
  for (let n = 2; n <= 20; n++) candidates.push(`${wanted}-${n}`);
  for (const candidate of candidates) {
    if (!isSafeName(candidate)) continue;
    const taken = app.db
      .query(
        "SELECT 1 FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(ownerId, candidate);
    if (!taken) return candidate;
  }
  return undefined;
}

/** `https://codeberg.org` → `codeberg`; a name segment, safe for a repo. */
export function hostLabel(webUrl: string): string {
  let host: string;
  try {
    host = new URL(webUrl).hostname;
  } catch {
    host = webUrl;
  }
  const label = host.replace(/^www\./, "").split(".")[0] ?? host;
  const cleaned = label.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned === "" ? "origin" : cleaned;
}
