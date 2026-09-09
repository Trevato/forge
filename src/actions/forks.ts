/**
 * Forks that follow their parent. A fork's default branch is a copy of the
 * parent's until someone commits on it; while that is so, the parent moving
 * is the fork moving — fast-forward only, never a merge, so a fork someone
 * works on directly is left exactly as they left it, and told.
 *
 * `followParents` keeps every fork current as pushes land (a mirror's sync
 * is a push too, so a fork of a mirror follows the origin); `syncFork` is
 * the same step asked for by hand, with the answer when it cannot be done,
 * and `forkDrift` is what a surface says before either happens.
 */

import type { App } from "../app.ts";
import type { ForgeEvent } from "../core/events.ts";
import { getRepoById, listForks, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { divergence } from "../git/branches.ts";
import { fetchInto, mergeBase, resolveOid, writeRef } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

const log = createLog("forks");
const ZERO = "0".repeat(40);

export interface ForkSync {
  /** Whether the fork's default branch moved. */
  readonly updated: boolean;
  /** The fork's tip before, and after. Equal when nothing moved. */
  readonly from: string;
  readonly to: string;
}

export type SyncForkError = AccessError | "not_a_fork" | "diverged";

/** Bring a fork's default branch up to its parent's, if nothing was committed on it. */
export async function syncFork(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<ForkSync, SyncForkError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent =
    fork.forkParentId === null
      ? undefined
      : getRepoById(app.db, fork.forkParentId);
  if (parent === undefined) return err("not_a_fork");
  return fastForward(app, fork, parent, writer.value.id);
}

export interface ForkDrift {
  /** Commits the parent's default branch has that the fork's has not. */
  readonly behind: number | null;
  /** Commits the fork's default branch has of its own. */
  readonly ahead: number | null;
}

/**
 * How far a fork's default branch sits from its parent's — `behind` is what
 * an update would bring, `ahead` is what makes one impossible. A read, not a
 * mutation: no authorization, because the caller has already established it
 * may see the fork. The parent's objects reach the fork through its
 * alternates, so one `rev-list --left-right --count` in the fork answers
 * both halves; when it cannot (a detached fork, an empty branch) both are
 * null and a surface says nothing rather than guessing.
 */
export async function forkDrift(
  app: App,
  fork: Repo,
  parent: Repo,
): Promise<ForkDrift> {
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const parentDir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  const head = await resolveOid(forkDir, `refs/heads/${fork.defaultBranch}`);
  const base = await resolveOid(
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
  );
  if (head === undefined || base === undefined)
    return { ahead: null, behind: null };
  return divergence(forkDir, base, head);
}

/**
 * The fork's default branch to the parent's, when the fork's tip is an
 * ancestor of the parent's — the fork has nothing of its own there. The
 * fork hears a push like any other, so what follows a push follows this.
 */
async function fastForward(
  app: App,
  fork: Repo,
  parent: Repo,
  actorId: string | undefined,
): Promise<Result<ForkSync, "diverged">> {
  const parentDir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const ref = `refs/heads/${fork.defaultBranch}`;
  const to = await resolveOid(parentDir, `refs/heads/${parent.defaultBranch}`);
  const from = await resolveOid(forkDir, ref);
  if (to === undefined || from === to)
    return ok({ updated: false, from: from ?? "", to: to ?? "" });
  // The parent's objects reach the fork through its alternates, so the
  // ancestry question is answerable before anything is fetched.
  if (from !== undefined && (await mergeBase(forkDir, from, to)) !== from)
    return err("diverged");
  const tip = await fetchInto(
    forkDir,
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
  );
  if (tip === undefined || !(await writeRef(forkDir, ref, tip)))
    return ok({ updated: false, from: from ?? "", to });
  app.bus.append({
    kind: "push",
    repoId: fork.id,
    actorId,
    payload: {
      updates: [{ ref, oldOid: from ?? ZERO, newOid: tip }],
      followed: `${parent.ownerName}/${parent.name}`,
    },
  });
  return ok({ updated: true, from: from ?? "", to: tip });
}

/** Keep forks current: a push to a parent's default branch fast-forwards each fork that can follow. */
export function followParents(app: App): () => void {
  return app.bus.subscribe((event: ForgeEvent) => {
    if (event.kind !== "push" || event.repoId === null) return;
    const updates = event.payload["updates"];
    if (!Array.isArray(updates)) return;
    const parent = getRepoById(app.db, event.repoId);
    if (parent === undefined) return;
    const moved = (updates as { ref?: unknown; newOid?: unknown }[]).some(
      (u) =>
        u.ref === `refs/heads/${parent.defaultBranch}` &&
        typeof u.newOid === "string" &&
        !/^0+$/.test(u.newOid),
    );
    if (!moved) return;
    for (const fork of listForks(app.db, parent.id)) {
      fastForward(app, fork, parent, event.actorId ?? undefined).catch(
        (error) =>
          log.error("fork could not follow its parent", {
            fork: `${fork.ownerName}/${fork.name}`,
            error: String(error),
          }),
      );
    }
  });
}
