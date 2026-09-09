/**
 * What a push moves besides its own branch.
 *
 * A branch that heads a pull elsewhere — a fork's, proposed upstream — moves
 * that pull: the base's snapshot of the branch (`refs/pull/N/head`) is
 * brought up to the new tip, and the base hears `pull.pushed` so a preview
 * or a check can follow.
 *
 * A fork's default branch is a copy of the parent's until someone commits
 * on it; while that is so, the parent moving is the fork moving —
 * fast-forward only, never a merge, so a fork someone works on directly is
 * left exactly as they left it. A mirror's sync is a push too, so a fork of
 * a mirror follows the origin.
 *
 * Both are subscribed by the app itself, so every push — over git, through
 * the API, from a sync — is followed the same way.
 */

import type { Database } from "bun:sqlite";
import type { EventBus, ForgeEvent } from "./events.ts";
import { listOpenPullsFromHead, type Pull } from "./pulls.ts";
import { getRepoById, listForks, type Repo } from "./repos.ts";
import { fetchInto, mergeBase, resolveOid, writeRef } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const log = createLog("following");
const ZERO = "0".repeat(40);

/** The forge, as far as following needs it. */
export interface Following {
  readonly db: Database;
  readonly reposRoot: string;
  readonly bus: EventBus;
}

interface Moved {
  readonly ref: string;
  readonly newOid: string;
}

/** The branches a push event moved, deletions left out. */
function movedBranches(event: ForgeEvent): Moved[] {
  const updates = event.payload["updates"];
  if (!Array.isArray(updates)) return [];
  const out: Moved[] = [];
  for (const u of updates as { ref?: unknown; newOid?: unknown }[]) {
    if (typeof u.ref !== "string" || typeof u.newOid !== "string") continue;
    if (!u.ref.startsWith("refs/heads/") || /^0+$/.test(u.newOid)) continue;
    out.push({ ref: u.ref, newOid: u.newOid });
  }
  return out;
}

/** Subscribe both follows; returns the unsubscribe. */
export function follow(forge: Following): () => void {
  return forge.bus.subscribe((event) => {
    if (event.kind !== "push" || event.repoId === null) return;
    const moved = movedBranches(event);
    if (moved.length === 0) return;
    const repo = getRepoById(forge.db, event.repoId);
    if (repo === undefined) return;
    const actor = event.actorId ?? undefined;
    followHeads(forge, repo, moved, actor).catch((error) =>
      log.error("pull heads could not follow a push", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(error),
      }),
    );
    if (moved.some((m) => m.ref === `refs/heads/${repo.defaultBranch}`))
      for (const fork of listForks(forge.db, repo.id))
        fastForwardFork(forge, fork, repo, actor).catch((error) =>
          log.error("fork could not follow its parent", {
            fork: `${fork.ownerName}/${fork.name}`,
            error: String(error),
          }),
        );
  });
}

/**
 * Bring a base's snapshot of a cross-repo pull's head up to the fork's
 * branch, when it moved. Best-effort by design: a deleted fork or a
 * vanished branch leaves the last snapshot in place, which is a stale diff
 * rather than no diff at all. Answers the new tip, or nothing.
 */
export async function refreshPullHead(
  forge: Pick<Following, "db" | "reposRoot">,
  repo: Repo,
  pull: Pull,
): Promise<string | undefined> {
  if (!pull.crossRepo || pull.originHeadRepo !== null) return undefined;
  if (pull.mergedAt !== null) return undefined;
  const head = getRepoById(forge.db, pull.headRepoId);
  if (head === undefined) return undefined;
  const headDir = repoDir(forge.reposRoot, head.ownerName, head.name);
  const baseDir = repoDir(forge.reposRoot, repo.ownerName, repo.name);
  // Two cheap `rev-parse`s before a fetch: this runs on every read of a
  // cross-repo pull, and the overwhelmingly common answer is "nothing moved".
  const [live, snapshot] = await Promise.all([
    resolveOid(headDir, `refs/heads/${pull.headBranch}`),
    resolveOid(baseDir, `refs/pull/${pull.number}/head`),
  ]);
  if (live === undefined || live === snapshot) return undefined;
  const tip = await fetchInto(
    baseDir,
    headDir,
    `refs/heads/${pull.headBranch}`,
  );
  if (tip === undefined) return undefined;
  await writeRef(baseDir, `refs/pull/${pull.number}/head`, tip);
  return tip;
}

async function followHeads(
  forge: Following,
  headRepo: Repo,
  moved: readonly Moved[],
  actorId: string | undefined,
): Promise<void> {
  for (const { ref } of moved) {
    const branch = ref.slice("refs/heads/".length);
    for (const pull of listOpenPullsFromHead(forge.db, headRepo.id, branch)) {
      const base = getRepoById(forge.db, pull.repoId);
      if (base === undefined) continue;
      const tip = await refreshPullHead(forge, base, pull);
      if (tip === undefined) continue;
      forge.bus.append({
        kind: "pull.pushed",
        repoId: base.id,
        actorId,
        payload: { number: pull.number, headOid: tip, branch },
      });
    }
  }
}

export interface ForkSync {
  /** Whether the fork's default branch moved. */
  readonly updated: boolean;
  /** The fork's tip before, and after. Equal when nothing moved. */
  readonly from: string;
  readonly to: string;
}

/**
 * The fork's default branch to the parent's, when the fork's tip is an
 * ancestor of the parent's — the fork has nothing of its own there. The
 * fork hears a push like any other, so what follows a push follows this.
 */
export async function fastForwardFork(
  forge: Following,
  fork: Repo,
  parent: Repo,
  actorId: string | undefined,
): Promise<Result<ForkSync, "diverged">> {
  const parentDir = repoDir(forge.reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(forge.reposRoot, fork.ownerName, fork.name);
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
  forge.bus.append({
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
