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
import { fetchInto, resolveOid, writeRef } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "./credential.ts";
import { redact, secretsIn } from "./credentials.ts";
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
  actorId: string,
): Promise<Result<void, PushThroughRefusal>> {
  // refs/pull/* is refused outright by the hook before we get here; this is
  // the second half of the same rule, so nothing forge-internal travels.
  const forwarded = updates.filter((u) => !u.ref.startsWith("refs/pull/"));
  const way = await wayThrough(app, repo, actorId);
  if (!way.ok) return way;
  if (way.value === undefined || forwarded.length === 0) return ok();
  const { link, authEnv } = way.value;
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
  if (!pushed.ok) return err(refusedBy(link, pushed.error.message, authEnv));
  return ok();
}

/**
 * A branch of a native fork, carried to the mirror's origin so a pull can
 * open from it there. It travels under the connecting account's credential
 * with the lease the mirror holds for that branch, exactly as a push through
 * the mirror would; the mirror's own copy of the branch then follows, so
 * what the origin holds is what the forge shows. Answers the new tip.
 */
export async function carryBranchThrough(
  app: App,
  mirror: Repo,
  fork: Repo,
  branch: string,
  actorId: string,
): Promise<Result<string, PushThroughRefusal>> {
  const way = await wayThrough(app, mirror, actorId);
  if (!way.ok) return way;
  if (way.value === undefined)
    return err({ message: "this repository does not mirror an origin" });
  const { link, authEnv } = way.value;
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const mirrorDir = repoDir(app.reposRoot, mirror.ownerName, mirror.name);
  const ref = `refs/heads/${branch}`;
  const tip = await resolveOid(forkDir, ref);
  if (tip === undefined)
    return err({
      message: `${fork.ownerName}/${fork.name} has no branch ${branch}`,
    });
  const held = (await resolveOid(mirrorDir, ref)) ?? ZERO_OID_STRING;
  const pushed = await pushToOrigin(
    forkDir,
    link.cloneUrl,
    [{ ref, oldOid: held, newOid: tip }],
    authEnv,
    { timeoutMs: TIMEOUT_MS },
  );
  if (!pushed.ok) return err(refusedBy(link, pushed.error.message, authEnv));
  const fetched = await fetchInto(mirrorDir, forkDir, ref);
  if (fetched !== undefined) await writeRef(mirrorDir, ref, fetched);
  return ok(tip);
}

const ZERO_OID_STRING = "0".repeat(40);

/** The origin's refusal, in its words, with the credential kept out of them. */
function refusedBy(
  link: NonNullable<ReturnType<typeof originForRepo>>,
  message: string,
  authEnv: Record<string, string>,
): PushThroughRefusal {
  // The pusher is a local writer; the credential is the owner's. The
  // origin's message is shown verbatim, so an origin that quotes the
  // token back (a hostile one, or a hook that prints its environment)
  // must not turn a refusal into a disclosure. The generic scrub in
  // git-mirror.ts cannot know the token; this one does.
  return {
    message: redact(
      `${link.fullName} on ${link.origin.webUrl} refused this push: ${message}`,
      ...secretsIn(authEnv),
    ),
  };
}

/**
 * The way through for a repository: nothing for a native one, the origin
 * link and a credential for a mirror, or the reason there is none.
 */
async function wayThrough(
  app: App,
  repo: Repo,
  actorId: string,
): Promise<
  Result<
    | {
        link: NonNullable<ReturnType<typeof originForRepo>>;
        authEnv: Record<string, string>;
      }
    | undefined,
    PushThroughRefusal
  >
> {
  const link = originForRepo(app.db, repo.id);
  if (!link) {
    // A mirror whose origin was disconnected keeps its provenance but has
    // nowhere to forward to. Accepting the push would let it diverge from
    // an upstream it still claims to mirror, so it fails closed until the
    // origin is reconnected (or the repo is re-created as a native one).
    if (detachedMirror(app, repo))
      return err({
        message:
          "this repository mirrors an origin that was disconnected; reconnect the origin before pushing",
      });
    return ok(undefined);
  }
  // The push travels under the connecting user's credential, so only they
  // may send it — the same rule write-through applies. Anyone else would
  // land commits upstream authenticated as someone else.
  if (actorId !== link.origin.userId)
    return err({
      message: `only the account that connected ${link.origin.webUrl} can push through this mirror`,
    });
  if (link.cloneUrl === "")
    return err({
      message: "this mirror has no upstream clone URL; re-mirror it",
    });

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
  return ok({ link, authEnv });
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

/** Provenance without a live origin row: `origin_id` is null, the name remains. */
function detachedMirror(app: App, repo: Repo): boolean {
  const row = app.db
    .query<
      { n: string | null },
      [string]
    >("SELECT origin_full_name AS n FROM repo WHERE id = ?1")
    .get(repo.id);
  return row?.n !== null && row?.n !== undefined && row.n !== "";
}
