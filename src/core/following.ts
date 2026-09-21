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
import {
  aheadCount,
  fetchInto,
  merge,
  mergeBase,
  mergeable,
  resolveOid,
  writeRef,
  type MergeIdentity,
} from "../git/merge.ts";
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
        fastForwardFork(forge, fork, repo, actor)
          .then((followed) => {
            // A fork with work of its own cannot be moved; it is told the
            // parent moved, and whoever listens (the crew, a card) takes it
            // from there. The fast-forward is silent because it changed
            // nothing the fork's owner would want to know about.
            if (followed.ok) return;
            forge.bus.append({
              kind: "fork.diverged",
              repoId: fork.id,
              actorId: actor,
              payload: {
                parent: `${repo.ownerName}/${repo.name}`,
                parentId: repo.id,
              },
            });
          })
          .catch((error) =>
            log.error("fork could not follow its parent", {
              fork: `${fork.ownerName}/${fork.name}`,
              error: String(error),
            }),
          );
  });
}

/**
 * Where a fork stands against its parent, at rest. `synced` is the copy
 * nobody has touched; `behind` has nothing of its own and can simply move;
 * `ahead` has its own work and the parent has not moved; `diverged` has
 * both, and git says whether they still merge cleanly and, if not, which
 * files need a decision. Every number is read from git each time — the
 * database never caches a relationship it could get wrong.
 */
export type RelationState = "synced" | "behind" | "ahead" | "diverged";

export interface ForkRelation {
  readonly parent: Repo;
  readonly state: RelationState;
  /** Commits on the parent's default branch the fork does not have. */
  readonly behind: number;
  /** Commits on the fork's default branch the parent does not have. */
  readonly ahead: number;
  /** For `diverged`: whether git merges the two without a conflict. */
  readonly clean: boolean;
  /** For `diverged` and not clean: the files both sides changed. */
  readonly conflicts: readonly string[];
  readonly forkTip: string;
  readonly parentTip: string;
}

export async function forkRelation(
  forge: Pick<Following, "db" | "reposRoot">,
  fork: Repo,
  parent?: Repo,
): Promise<ForkRelation | undefined> {
  const p =
    parent ??
    (fork.forkParentId === null
      ? undefined
      : getRepoById(forge.db, fork.forkParentId));
  if (p === undefined) return undefined;
  const parentDir = repoDir(forge.reposRoot, p.ownerName, p.name);
  const forkDir = repoDir(forge.reposRoot, fork.ownerName, fork.name);
  const [parentTip, forkTip] = await Promise.all([
    resolveOid(parentDir, `refs/heads/${p.defaultBranch}`),
    resolveOid(forkDir, `refs/heads/${fork.defaultBranch}`),
  ]);
  const at = (
    state: RelationState,
    behind: number,
    ahead: number,
    clean = true,
    conflicts: readonly string[] = [],
  ): ForkRelation => ({
    parent: p,
    state,
    behind,
    ahead,
    clean,
    conflicts,
    forkTip: forkTip ?? "",
    parentTip: parentTip ?? "",
  });
  // An empty side has nothing to follow or to differ by.
  if (parentTip === undefined || forkTip === undefined || parentTip === forkTip)
    return at("synced", 0, 0);
  // The parent's objects reach the fork through its alternates, so every
  // question here is answered inside the fork without a fetch.
  const base = await mergeBase(forkDir, forkTip, parentTip);
  if (base === undefined) return at("diverged", 0, 0, false);
  const [behind, ahead] = await Promise.all([
    aheadCount(forkDir, forkTip, parentTip),
    aheadCount(forkDir, parentTip, forkTip),
  ]);
  if (ahead === 0) return at("behind", behind, 0);
  if (behind === 0) return at("ahead", 0, ahead);
  const merged = await mergeable(forkDir, forkTip, parentTip);
  if (merged.ok) return at("diverged", behind, ahead, true);
  return at(
    "diverged",
    behind,
    ahead,
    false,
    merged.error.kind === "conflict" ? merged.error.files : [],
  );
}

export type TakeError =
  | { kind: "conflict"; files: readonly string[] }
  | { kind: "moved" }
  | { kind: "git"; message: string };

/**
 * Take the parent's updates into the fork's default branch: a fast-forward
 * when the fork has nothing of its own, a merge commit when it has and git
 * merges cleanly, and a refusal naming the files when it does not. The
 * merge is plumbing in the bare repo — no clone — and lands only if the
 * fork's tip is still where it was read. What follows a push follows this.
 */
export async function takeUpdates(
  forge: Following,
  fork: Repo,
  parent: Repo,
  author: MergeIdentity & { readonly id: string },
): Promise<Result<ForkSync & { merged: boolean }, TakeError>> {
  const relation = await forkRelation(forge, fork, parent);
  if (relation === undefined) return err({ kind: "git", message: "no parent" });
  if (relation.state === "synced" || relation.state === "ahead")
    return ok({
      updated: false,
      merged: false,
      from: relation.forkTip,
      to: relation.forkTip,
    });
  if (relation.state === "behind") {
    const moved = await fastForwardFork(forge, fork, parent, author.id);
    if (moved.ok) return ok({ ...moved.value, merged: false });
    // Diverged between the read and the move: fall through to the merge.
  }
  const again = await forkRelation(forge, fork, parent);
  if (again === undefined || again.state !== "diverged")
    return err({ kind: "moved" });
  if (!again.clean) return err({ kind: "conflict", files: again.conflicts });
  const parentDir = repoDir(forge.reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(forge.reposRoot, fork.ownerName, fork.name);
  // The parent's objects are visible through the alternates already; the
  // fetch makes the fork own what its new commit points at.
  const tip = await fetchInto(
    forkDir,
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
  );
  if (tip === undefined) return err({ kind: "git", message: "fetch failed" });
  const ref = `refs/heads/${fork.defaultBranch}`;
  const landed = await merge(forkDir, {
    baseBranch: fork.defaultBranch,
    baseOid: again.forkTip,
    headOid: tip,
    strategy: "merge",
    message: `Take updates from ${parent.ownerName}/${parent.name}`,
    author,
  });
  if (!landed.ok) {
    if (landed.error.kind === "conflict")
      return err({ kind: "conflict", files: landed.error.files });
    if (landed.error.kind === "base_moved") return err({ kind: "moved" });
    return err({
      kind: "git",
      message: landed.error.kind === "git" ? landed.error.message : "unsafe",
    });
  }
  forge.bus.append({
    kind: "push",
    repoId: fork.id,
    actorId: author.id,
    payload: {
      updates: [{ ref, oldOid: again.forkTip, newOid: landed.value.mergeOid }],
      followed: `${parent.ownerName}/${parent.name}`,
      merged: true,
    },
  });
  return ok({
    updated: true,
    merged: true,
    from: again.forkTip,
    to: landed.value.mergeOid,
  });
}

/**
 * Stage the parent's default branch inside the fork at
 * `refs/following/<branch>`, so a clone of the fork can fetch exactly what
 * it is being asked to take — the crew's converge run does — without
 * needing to read the parent at all. Answers the staged tip.
 */
export async function stageParent(
  forge: Pick<Following, "reposRoot">,
  fork: Repo,
  parent: Repo,
): Promise<string | undefined> {
  const parentDir = repoDir(forge.reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(forge.reposRoot, fork.ownerName, fork.name);
  const tip = await fetchInto(
    forkDir,
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
  );
  if (tip === undefined) return undefined;
  const ref = `refs/following/${parent.defaultBranch}`;
  return (await writeRef(forkDir, ref, tip)) ? tip : undefined;
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
  // The row says where the head is too, so a reader of the pull — the API,
  // a page — sees the same tip the ref holds.
  forge.db
    .query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1")
    .run(pull.id, tip);
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

/**
 * A repository's family: the oldest ancestor the viewer may see, and every
 * fork under it, each with its standing against its own parent. The tree
 * is what makes "who follows whom" one glance instead of a walk through
 * fork lists. Bounded on purpose — a family of thousands is a list page's
 * problem — and a fork the viewer may not read is simply not in it.
 */
export interface LineageNode {
  readonly repo: Repo;
  /** Against this node's parent; absent on the root, and past the budget. */
  readonly relation: ForkRelation | undefined;
  readonly children: readonly LineageNode[];
}

export interface Lineage {
  readonly root: LineageNode;
  /** How many repositories the tree holds, the root included. */
  readonly size: number;
  /** Whether forks were left out to stay inside the bound. */
  readonly truncated: boolean;
}

const LINEAGE_MAX_NODES = 60;
const LINEAGE_MAX_RELATIONS = 30;
const LINEAGE_MAX_DEPTH = 6;

export async function lineageOf(
  forge: Pick<Following, "db" | "reposRoot">,
  repo: Repo,
  mayRead: (r: Repo) => boolean,
): Promise<Lineage> {
  // Up: as far as the viewer may see, and never in circles.
  let top = repo;
  const seen = new Set<string>([repo.id]);
  while (top.forkParentId !== null && seen.size <= LINEAGE_MAX_DEPTH) {
    const parent = getRepoById(forge.db, top.forkParentId);
    if (parent === undefined || !mayRead(parent) || seen.has(parent.id)) break;
    seen.add(parent.id);
    top = parent;
  }
  // Down: breadth first, so a bound cuts the deepest and newest, not a
  // whole branch of the family.
  let size = 1;
  let relations = 0;
  let truncated = false;
  interface Draft {
    repo: Repo;
    relation: ForkRelation | undefined;
    children: Draft[];
  }
  const root: Draft = { repo: top, relation: undefined, children: [] };
  let level: Draft[] = [root];
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH && level.length > 0; depth++) {
    const next: Draft[] = [];
    for (const node of level) {
      for (const fork of listForks(forge.db, node.repo.id)) {
        if (!mayRead(fork)) continue;
        if (size >= LINEAGE_MAX_NODES) {
          truncated = true;
          break;
        }
        size++;
        const relation =
          relations < LINEAGE_MAX_RELATIONS
            ? await forkRelation(forge, fork, node.repo)
            : undefined;
        if (relation !== undefined) relations++;
        const child: Draft = { repo: fork, relation, children: [] };
        node.children.push(child);
        next.push(child);
      }
    }
    level = next;
  }
  if (level.some((n) => listForks(forge.db, n.repo.id).length > 0))
    truncated = true;
  return { root, size, truncated };
}
