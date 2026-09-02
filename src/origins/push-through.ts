/**
 * Pushing through: a `git push` to a mirror lands upstream, or it does not
 * land at all.
 *
 * **Where this runs, and why.** It runs in **pre-receive**, before the local
 * refs move. That is the whole point — the origin is truth for a mirrored
 * repo, so if the origin refuses (a protected branch, a lost race, a revoked
 * token) the local push must be refused too, with the origin's own words. A
 * post-receive push-through would have already accepted the objects and
 * would leave the mirror silently ahead of its origin, which is exactly the
 * divergence the whole feature exists to prevent.
 *
 * **How it can work at all.** During pre-receive the pushed objects are not
 * yet in the repository's object store — they sit in a quarantine directory,
 * and a plain `git push` from the bare repo would not find them. Git tells
 * the hook where they are through `GIT_QUARANTINE_PATH`,
 * `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and the
 * forge already forwards all three (`git/hook-protocol.ts`). Handing them to
 * `git push` makes the new objects visible to pack-objects, so the pack we
 * send upstream is built from the quarantine — the same bytes the pusher
 * just sent us, before we have committed to keeping them.
 *
 * **What it refuses.** `refs/pull/*` is the forge's own namespace and never
 * travels. Everything else goes with an explicit refspec and an explicit
 * lease (`git-mirror.ts` will not build a command without both).
 */

import type { App } from "../app.ts";
import { originForRepo } from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import { FORWARDED_GIT_ENV, type RefUpdate } from "../git/hook-protocol.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "./credential.ts";
import { pushToOrigin } from "./git-mirror.ts";

/** A push-through must not outlive a pusher's patience. */
const TIMEOUT_MS = 60_000;

export interface PushThroughRefusal {
  /** Shown to the pusher verbatim; already scrubbed of credentials. */
  readonly message: string;
}

/**
 * Forward a push to the repo's origin, if it has one. A native repo returns
 * `ok` immediately — this is on the hot path of every push in the forge, so
 * the non-mirror case is one indexed lookup and nothing else.
 */
export async function pushThrough(
  app: App,
  repo: Repo,
  updates: readonly RefUpdate[],
  hookEnv: Record<string, string>,
): Promise<Result<void, PushThroughRefusal>> {
  const link = originForRepo(app.db, repo.id);
  if (!link) return ok();
  if (link.cloneUrl === "")
    return err({
      message: "this mirror has no upstream clone URL; re-mirror it",
    });

  // refs/pull/* is refused outright by the hook before we get here; this is
  // the second half of the same rule, so nothing forge-internal travels.
  const forwarded = updates.filter((u) => !u.ref.startsWith("refs/pull/"));
  if (forwarded.length === 0) return ok();

  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok)
    return err({
      message: `${link.origin.webUrl}: this origin needs to be reconnected`,
    });

  const authEnv = await provider.value.gitAuthEnv(link.cloneUrl);
  if (Object.keys(authEnv).length === 0)
    return err({
      message: `${link.origin.webUrl}: this origin needs to be reconnected`,
    });

  const pushed = await pushToOrigin(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    link.cloneUrl,
    forwarded.map((u) => ({
      ref: u.ref,
      oldOid: u.oldOid,
      newOid: u.newOid,
    })),
    authEnv,
    { env: quarantineEnv(hookEnv), timeoutMs: TIMEOUT_MS },
  );
  if (!pushed.ok) {
    return err({
      message: `${link.fullName} on ${link.origin.webUrl} refused this push: ${pushed.error.message}`,
    });
  }
  return ok();
}

/**
 * Only the object-store variables git itself set for this push. Copying the
 * hook's whole environment would let a pusher-influenced variable reach a
 * git subprocess, and `gitEnv()` exists precisely to stop that.
 */
function quarantineEnv(
  hookEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED_GIT_ENV) {
    const value = hookEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}
