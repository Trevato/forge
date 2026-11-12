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
import { getMirrorTarget, recordMirrorPush } from "../core/migrate_mirror.ts";
import {
  detachedMirror,
  getOriginById,
  originForRepo,
} from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import { FORWARDED_GIT_ENV, type RefUpdate } from "../git/hook-protocol.ts";
import { fetchInto, resolveOid, writeRef } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin, READ_ONLY, writesPaused } from "./credential.ts";
import { redact, secretsIn } from "./credentials.ts";
import { pushToOrigin, snapshotRefs } from "./git-mirror.ts";
import { denied } from "./operator.ts";

/** A push-through must not outlive a pusher's patience. */
const TIMEOUT_MS = 60_000;

export interface PushThroughRefusal {
  /** Shown to the pusher verbatim; already scrubbed of credentials. */
  readonly message: string;
  /** The origin itself refused the push (no rights there), not this forge. */
  readonly byOrigin?: boolean;
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
  /** The branch's name on the origin; the fork's own name unless given. */
  as: string = branch,
): Promise<Result<string, PushThroughRefusal>> {
  const way = await wayThrough(app, mirror, actorId);
  if (!way.ok) return way;
  if (way.value === undefined)
    return err({ message: "this repository does not mirror an origin" });
  const { link, authEnv } = way.value;
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const mirrorDir = repoDir(app.reposRoot, mirror.ownerName, mirror.name);
  const ref = `refs/heads/${branch}`;
  const carriedRef = `refs/heads/${as}`;
  const tip = await resolveOid(forkDir, ref);
  if (tip === undefined)
    return err({
      message: `${fork.ownerName}/${fork.name} has no branch ${branch}`,
    });
  const held = (await resolveOid(mirrorDir, carriedRef)) ?? ZERO_OID_STRING;
  const pushed = await pushToOrigin(
    forkDir,
    link.cloneUrl,
    [{ ref: carriedRef, oldOid: held, newOid: tip }],
    authEnv,
    { timeoutMs: TIMEOUT_MS },
  );
  if (!pushed.ok) return err(refusedBy(link, pushed.error.message, authEnv));
  const fetched = await fetchInto(mirrorDir, forkDir, ref);
  if (fetched !== undefined) await writeRef(mirrorDir, carriedRef, fetched);
  return ok(tip);
}

const ZERO_OID_STRING = "0".repeat(40);

/** What a push to a protected repository is told, everywhere. */
export const protectedMessage = (webUrl: string, fullName: string): string =>
  `${fullName} on ${webUrl} is protected by this forge's operator: nothing is pushed to it from here. Propose the change from your fork instead.`;

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
    byOrigin: true,
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
    if (detachedMirror(app.db, repo.id) !== undefined)
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

  if (link.origin.readOnly)
    return err({ message: `${link.origin.webUrl}: ${READ_ONLY}` });
  const paused = writesPaused(app, link.origin.id);
  if (paused !== undefined)
    return err({ message: `${link.origin.webUrl}: ${paused}` });
  // A repository the operator protects is never pushed to from here, even
  // by an account that could: changes to it go up as pulls from a fork.
  if (denied(link.origin, link.fullName))
    return err({ message: protectedMessage(link.origin.webUrl, link.fullName) });

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

/**
 * The read-only mirror a migration left behind: after a landing, every
 * branch the source held at migration that moved goes to it under the credential of
 * the person who chose it — the same rules as a push through a mirror
 * (header in env, explicit refspec and lease, `refs/pull/*` never). The
 * lease is what the target last held, so a target that moved on its own
 * refuses the push and says so instead of being overwritten. Answers how
 * many branches went; a failure is recorded on the target, not thrown.
 */
export async function pushToMirrorTarget(
  app: App,
  repo: Repo,
): Promise<Result<number, PushThroughRefusal>> {
  const target = getMirrorTarget(app.db, repo.id);
  if (!target) return ok(0);
  const fail = (message: string): Result<number, PushThroughRefusal> => {
    recordMirrorPush(app.db, repo.id, target.tips, message);
    return err({ message });
  };
  const origin = getOriginById(app.db, target.originId);
  if (!origin) return fail("the origin was disconnected; reconnect it");
  if (origin.readOnly) return fail(READ_ONLY);
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return fail("the origin needs to be reconnected");
  const authEnv = await provider.value.gitAuthEnv(target.cloneUrl);
  if (Object.keys(authEnv).length === 0)
    return fail("the origin needs to be reconnected");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const { refs } = await snapshotRefs(dir);
  const updates = [...refs]
    .filter(
      ([ref, oid]) =>
        // Only what the source held at migration: the crew's work branches
        // and pull heads are unreviewed and never leave the forge.
        Object.hasOwn(target.tips, ref) && target.tips[ref] !== oid,
    )
    .map(([ref, newOid]) => ({
      ref,
      oldOid: target.tips[ref] ?? ZERO_OID_STRING,
      newOid,
    }));
  if (updates.length === 0) return ok(0);
  const pushed = await pushToOrigin(dir, target.cloneUrl, updates, authEnv, {
    timeoutMs: TIMEOUT_MS,
  });
  if (!pushed.ok)
    return fail(
      redact(
        `${target.fullName} refused the mirror push: ${pushed.error.message}`,
        ...secretsIn(authEnv),
      ),
    );
  const tips = { ...target.tips };
  for (const u of updates) tips[u.ref] = u.newOid;
  recordMirrorPush(app.db, repo.id, tips, "");
  return ok(updates.length);
}
