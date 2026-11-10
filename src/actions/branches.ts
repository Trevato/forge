/**
 * Branch actions: the platform mutation behind "make a branch".
 *
 * A native repo moves its ref locally and announces it. A **mirrored** repo
 * does not: the origin is truth (`docs/ORIGINS.md`), so the ref is pushed
 * upstream first, under the origin owner's own credential, and the local ref
 * moves only if the origin took it. That ordering is the whole point — a
 * local branch the origin refused would be exactly the divergence mirroring
 * exists to prevent — and it is why these actions cannot be replaced by a
 * bare `update-ref` in an adapter.
 *
 * `update-ref` runs no hooks, so the event is appended here; webhooks, SSE
 * and anything watching the outbox see a branch appear exactly as they would
 * if it had arrived over the wire.
 */

import type { App } from "../app.ts";
import { originForRepo } from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import {
  createBranch as gitCreateBranch,
  deleteBranch as gitDeleteBranch,
  isBranchName,
  startOid,
  type BranchRef,
  type CreateBranchError,
  type DeleteBranchError,
} from "../git/branches.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin, writesPaused } from "../origins/credential.ts";
import { denied } from "../origins/operator.ts";
import { redact, secretsIn } from "../origins/credentials.ts";
import { pushToOrigin, type PushUpdate } from "../origins/git-mirror.ts";
import type { WriteThroughError } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";

const ZERO = "0".repeat(40);

export type CreateBranchActionError =
  | AccessError
  | CreateBranchError
  | WriteThroughError;

export type DeleteBranchActionError =
  | AccessError
  | DeleteBranchError
  | "default_branch"
  | WriteThroughError;

export interface CreateBranchInput {
  name: string;
  /** Where the branch starts. @default the repo's default branch */
  from?: string;
}

/**
 * Create a branch. On a mirror the ref is created upstream first, with an
 * empty lease — git's own "must not already exist" — so two forges racing to
 * create the same branch cannot both believe they won.
 */
export async function createBranch(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: CreateBranchInput,
): Promise<Result<BranchRef, CreateBranchActionError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;

  const name = input.name.trim();
  if (!isBranchName(name)) return err("invalid_name");
  const from = (input.from ?? "").trim() || repo.defaultBranch;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);

  const push = await originPush(app, writer.value, repo);
  if (!push.ok) return push;

  if (push.value !== undefined) {
    // Nothing moves locally until the origin has taken the ref, so the start
    // point is resolved rather than created: the mirror already holds the
    // objects, and the origin is asked for a commit it can see too.
    const oid = await startOid(dir, from);
    if (oid === undefined) return err("unknown_start");
    if (await currentOid(dir, name)) return err("exists");
    const pushed = await push.value([
      { ref: `refs/heads/${name}`, oldOid: ZERO, newOid: oid },
    ]);
    if (!pushed.ok) return err("origin_refused");
  }

  const created = await gitCreateBranch(dir, name, from);
  if (!created.ok) return created;

  app.bus.append({
    kind: "branch.created",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { name, from, oid: created.value.oid },
  });
  return created;
}

/**
 * Delete a branch. The default branch is never deletable — it is what HEAD
 * points at and what every clone lands on — and on a mirror the deletion
 * travels upstream before the local ref goes.
 */
export async function deleteBranch(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
): Promise<Result<BranchRef, DeleteBranchActionError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;

  const wanted = name.trim();
  if (!isBranchName(wanted)) return err("invalid_name");
  if (wanted === repo.defaultBranch) return err("default_branch");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const push = await originPush(app, writer.value, repo);
  if (!push.ok) return push;

  if (push.value !== undefined) {
    // Read the tip first so the upstream delete carries a real lease: the
    // origin drops the ref only if it still holds the commit we saw.
    const tip = await currentOid(dir, wanted);
    if (tip === undefined) return err("unknown_branch");
    const pushed = await push.value([
      { ref: `refs/heads/${wanted}`, oldOid: tip, newOid: ZERO },
    ]);
    if (!pushed.ok) return err("origin_refused");
  }

  const deleted = await gitDeleteBranch(dir, wanted);
  if (!deleted.ok) return deleted;

  app.bus.append({
    kind: "branch.deleted",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { name: wanted, oid: deleted.value.oid },
  });
  return deleted;
}

/** The tip of a branch, or undefined when it does not exist. */
async function currentOid(
  dir: string,
  name: string,
): Promise<string | undefined> {
  return await resolveOid(dir, `refs/heads/${name}`);
}

/**
 * How this repo's ref updates reach its origin, or `undefined` when the repo
 * is native and refs simply move locally.
 *
 * The credential belongs to a person, so only that person may push with it —
 * the same rule `write-through.ts` and the pre-receive push-through apply,
 * for the same reason: anyone else's branch would land upstream authenticated
 * as somebody who never made it.
 */
export async function originPush(
  app: App,
  actor: User,
  repo: Repo,
): Promise<
  Result<
    | ((updates: readonly PushUpdate[]) => Promise<Result<void, string>>)
    | undefined,
    WriteThroughError
  >
> {
  const link = originForRepo(app.db, repo.id);
  if (!link) return ok(undefined);
  if (link.origin.userId !== actor.id) return err("origin_owner_only");
  if (link.cloneUrl === "") return err("origin_unreachable");
  if (link.origin.readOnly) return err("origin_read_only");
  if (writesPaused(app, link.origin.id) !== undefined)
    return err("origin_paused");
  if (denied(link.origin, link.fullName)) return err("origin_protected");

  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok) return err("origin_unreachable");
  const authEnv = await provider.value.gitAuthEnv(link.cloneUrl);
  if (Object.keys(authEnv).length === 0) return err("origin_unreachable");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const cloneUrl = link.cloneUrl;
  const where = `${link.fullName} on ${link.origin.webUrl}`;
  return ok(async (updates) => {
    const pushed = await pushToOrigin(dir, cloneUrl, updates, authEnv);
    if (pushed.ok) return ok();
    // The origin's own words, scrubbed of anything that could carry the
    // token — an origin that quotes a credential back must not turn a
    // refusal into a disclosure.
    return err(
      redact(
        `${where} refused this change: ${pushed.error.message}`,
        ...secretsIn(authEnv),
      ),
    );
  });
}

/** Re-exported so callers need one import for the shape they get back. */
export type { BranchRef };
