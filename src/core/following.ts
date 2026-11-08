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
 * the API, from a sync — is followed the same way. A landed pull is one
 * more: the merge moves its base with `update-ref`, which announces no push,
 * so it is read here as the push it amounts to.
 */

import type { Database } from "bun:sqlite";
import type { EventBus, ForgeEvent } from "./events.ts";
import { getPull, listOpenPullsFromHead, type Pull } from "./pulls.ts";
import {
  getRepoById,
  listAncestors,
  listDescendants,
  listForks,
  type Repo,
} from "./repos.ts";
import {
  fetchInto,
  merge,
  mergeable,
  resolveOid,
  writeRef,
  type MergeIdentity,
} from "../git/merge.ts";
import { runGit } from "../git/env.ts";
import { describeLink, syncLink, type Reconcile } from "../git/sync_link.ts";
import { readTipOrAbsent } from "../git/tip.ts";
import { readTips } from "../git/tips.ts";
import { repoDir } from "../git/repos.ts";
import { combine } from "../git/combined.ts";
import { fromKeptFork } from "./landing_kind.ts";
import { forkFollowMode } from "./fork_follow.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const log = createLog("following");
const ZERO = "0".repeat(40);

/** The forge, as far as following needs it. */
export interface Following {
  readonly db: Database;
  readonly reposRoot: string;
  readonly bus: EventBus;
  /** Who a merge the forge makes for a fork's owner is written as; absent, a fork never merges by itself. */
  readonly authorOf?: (userId: string) => (MergeIdentity & { readonly id: string }) | undefined;
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

/** The base a landed pull moved, as the one update a push would have named. */
function landedBranch(db: Database, event: ForgeEvent): Moved[] {
  const number = event.payload["number"];
  const newOid = event.payload["mergeOid"];
  if (event.repoId === null || typeof number !== "number") return [];
  if (typeof newOid !== "string") return [];
  const pull = getPull(db, event.repoId, number);
  return pull === undefined
    ? []
    : [{ ref: `refs/heads/${pull.baseBranch}`, newOid }];
}

/** Subscribe both follows; returns the unsubscribe. */
export function follow(forge: Following): () => void {
  return forge.bus.subscribe((event) => {
    if (event.repoId === null) return;
    if (event.kind !== "push" && event.kind !== "pull.merged") return;
    const moved =
      event.kind === "push"
        ? movedBranches(event)
        : landedBranch(forge.db, event);
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
          .then(async (followed) => {
            // A fork with work of its own cannot be moved; it is told the
            // parent moved, and whoever listens (the crew, a card) takes it
            // from there. The fast-forward is silent because it changed
            // nothing the fork's owner would want to know about.
            if (followed.ok) return;
            // A fork that chose to take updates merges what git merges
            // cleanly; a conflict is told like any other divergence.
            const author = forge.authorOf?.(fork.ownerId);
            if (author !== undefined && forkFollowMode(forge.db, fork.id) === "take-updates") {
              const took = await takeUpdates(forge, fork, repo, author);
              if (took.ok) return;
            }
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
 * files need a decision. The tips are read from the ref files each time and
 * the comparison is memoized on that pair of tips, so a relationship is
 * recomputed only when either side moves; the database never holds it.
 */
const reconcileOf = (
  state: RelationState,
  behind: number,
  ahead: number,
  clean: boolean,
  conflicts: readonly string[],
): { action: Reconcile; words: string } => {
  // Two histories with no common commit count as nothing either way, and are not in sync.
  if (state === "diverged" && behind === 0 && ahead === 0)
    return { action: "keep-both", words: "The two sides share no history; keep both and choose which one to follow." };
  const { action, words } = describeLink(behind, ahead, clean, conflicts);
  return { action, words };
};

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
  /** The one action that reconciles the two, and the words for it: the sync contract's (`describeLink`). */
  readonly action: Reconcile;
  readonly words: string;
}

export async function forkRelation(
  forge: Pick<Following, "db" | "reposRoot">,
  fork: Repo,
  parent?: Repo,
  tips: TipReads = new Map(),
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
    tipOf(parentDir, `refs/heads/${p.defaultBranch}`, tips),
    tipOf(forkDir, `refs/heads/${fork.defaultBranch}`, tips),
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
    ...reconcileOf(state, behind, ahead, clean, conflicts),
  });
  // An empty side has nothing to follow or to differ by.
  if (parentTip === undefined || forkTip === undefined || parentTip === forkTip)
    return at("synced", 0, 0);
  // The answer is a function of the two tips: git is asked again only when
  // either moves (#6127).
  const key = `${forkDir}\0${parentDir}\0${forkTip}\0${parentTip}`;
  const known = relationCache.get(key);
  if (known !== undefined) return at(...known);
  const { standing, sure } = await compare(forkDir, forkTip, parentTip);
  // Only what git actually answered is kept: a timeout or a spawn failure
  // is wrong for this read, not for as long as the tips stand.
  if (sure) {
    if (relationCache.size >= RELATION_CACHE_MAX) relationCache.clear();
    relationCache.set(key, standing);
  }
  return at(...standing);
}

/** Tips already asked for in one read, so a parent is read once for all its forks. */
export type TipReads = Map<string, Promise<string | undefined>>;

/** The tip from the ref files; git is asked only when they cannot say. */
function tipOf(
  dir: string,
  ref: string,
  reads: TipReads,
): Promise<string | undefined> {
  const key = `${dir}\0${ref}`;
  let read = reads.get(key);
  if (read === undefined) {
    read = readTipOrAbsent(dir, ref).then((tip) =>
      // An unborn branch is nothing to spawn git for.
      tip === null ? undefined : (tip ?? resolveOid(dir, ref)),
    );
    reads.set(key, read);
  }
  return read;
}

type Standing = [
  RelationState,
  behind: number,
  ahead: number,
  clean: boolean,
  conflicts: readonly string[],
];

const RELATION_CACHE_MAX = 500;
const relationCache = new Map<string, Standing>();

/** How many times git was asked to compare two tips (for tests). */
export const comparisons = { count: 0 };

async function compare(
  forkDir: string,
  forkTip: string,
  parentTip: string,
): Promise<{ standing: Standing; sure: boolean }> {
  comparisons.count++;
  const at = (
    state: RelationState,
    behind: number,
    ahead: number,
    clean = true,
    conflicts: readonly string[] = [],
    sure = true,
  ) => ({
    standing: [state, behind, ahead, clean, conflicts] as Standing,
    sure,
  });
  // The parent's objects reach the fork through its alternates, so every
  // question here is answered inside the fork without a fetch.
  const base = await runGit(["merge-base", forkTip, parentTip], { cwd: forkDir });
  if (!base.ok) {
    // Exit 1 with nothing said is git's answer for histories with no common
    // ancestor; any other failure is not an answer.
    const unrelated = base.error.code === 1 && base.error.stderr === "";
    return at("diverged", 0, 0, false, [], unrelated);
  }
  const count = (from: string, to: string) =>
    runGit(["rev-list", "--count", `${from}..${to}`], { cwd: forkDir });
  const [b, a] = await Promise.all([
    count(forkTip, parentTip),
    count(parentTip, forkTip),
  ]);
  const sure = b.ok && a.ok;
  const behind = b.ok ? Number(b.value) || 0 : 0;
  const ahead = a.ok ? Number(a.value) || 0 : 0;
  if (ahead === 0) return at("behind", behind, 0, true, [], sure);
  if (behind === 0) return at("ahead", 0, ahead, true, [], sure);
  const merged = await mergeable(forkDir, forkTip, parentTip);
  if (merged.ok) return at("diverged", behind, ahead, true, [], sure);
  const conflict = merged.error.kind === "conflict";
  return at(
    "diverged",
    behind,
    ahead,
    false,
    conflict ? merged.error.files : [],
    sure && conflict,
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
  // A sealed pull's snapshot stays where its work lives, out of the base
  // everyone reads (`pullDir`, `core/sealed.ts`).
  const apart = pull.sealed && head.sealedFor === repo.id;
  const snapshotDir = apart ? headDir : baseDir;
  // This runs on every read of a cross-repo pull, and the overwhelmingly
  // common answer is "nothing moved": both tips come from the ref files, and
  // git is asked only for one they cannot say (#8157).
  const headRef = `refs/heads/${pull.headBranch}`;
  const pullRef = `refs/pull/${pull.number}/head`;
  const [heads, snaps] = await Promise.all([
    readTips(headDir, [headRef]),
    readTips(snapshotDir, [pullRef]),
  ]);
  const live = heads.get(headRef) ?? (await resolveOid(headDir, headRef));
  if (live === undefined) return undefined;
  const snapshot = snaps.get(pullRef) ?? (await resolveOid(snapshotDir, pullRef));
  if (live === snapshot) return undefined;
  const tip = apart
    ? live
    : await fetchInto(baseDir, headDir, `refs/heads/${pull.headBranch}`);
  if (tip === undefined) return undefined;
  await writeRef(snapshotDir, `refs/pull/${pull.number}/head`, tip);
  // The row says where the head is too, so a reader of the pull — the API,
  // a page — sees the same tip the ref holds.
  forge.db
    .query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1")
    .run(pull.id, tip);
  // A kept fork's pull is combined with main on our side (#9012).
  if (!apart && fromKeptFork(forge.db, pull)) {
    const baseTip = await resolveOid(baseDir, `refs/heads/${pull.baseBranch}`);
    if (baseTip !== undefined)
      await combine(baseDir, { number: pull.number, baseOid: baseTip, headOid: tip });
  }
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
  // The contract (`syncLink`): their tip is staged whole, and the fork's
  // branch moves only by a fast-forward, compare-and-swap. Both paths are
  // computed here from repository rows, never from text a person typed.
  const synced = await syncLink(
    forkDir,
    ref,
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
    `refs/following/${parent.defaultBranch}`,
  );
  if (!synced.ok) return ok({ updated: false, from: from ?? "", to });
  if (!synced.value.moved)
    return synced.value.judgement.state === "synced"
      ? ok({ updated: false, from: from ?? "", to })
      : err("diverged");
  const tip = synced.value.to;
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
  // Up: as far as the viewer may see, and never in circles. One read for
  // the whole chain; the viewer's predicate cuts it afterwards.
  let top = repo;
  const seen = new Set<string>([repo.id]);
  for (const parent of listAncestors(forge.db, repo.id, LINEAGE_MAX_DEPTH)) {
    if (!mayRead(parent) || seen.has(parent.id)) break;
    seen.add(parent.id);
    top = parent;
  }
  // Down: one read for every fork below, one generation past the bound so
  // "more below" can be told, grouped by parent here.
  const below = new Map<string, Repo[]>();
  for (const fork of listDescendants(forge.db, top.id, LINEAGE_MAX_DEPTH + 1)) {
    const parentId = fork.forkParentId;
    if (parentId === null) continue;
    const siblings = below.get(parentId);
    if (siblings === undefined) below.set(parentId, [fork]);
    else siblings.push(fork);
  }
  const forksOf = (id: string): readonly Repo[] => below.get(id) ?? [];
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
  const tips: TipReads = new Map();
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH && level.length > 0; depth++) {
    const next: Draft[] = [];
    const asked: Promise<void>[] = [];
    for (const node of level) {
      for (const fork of forksOf(node.repo.id)) {
        if (!mayRead(fork)) continue;
        if (size >= LINEAGE_MAX_NODES) {
          truncated = true;
          break;
        }
        size++;
        const child: Draft = { repo: fork, relation: undefined, children: [] };
        // The budget is spent in order; the reads themselves run together.
        // Against an archived parent a count reads as unshipped work, so
        // none is taken (#7452).
        if (node.repo.archivedAt === null && relations < LINEAGE_MAX_RELATIONS) {
          relations++;
          asked.push(
            forkRelation(forge, fork, node.repo, tips).then((r) => {
              child.relation = r;
            }),
          );
        }
        node.children.push(child);
        next.push(child);
      }
    }
    await Promise.all(asked);
    level = next;
  }
  // "More below" only for forks this viewer could see: a private fork past
  // the bound is not hinted at, any more than one inside it is shown.
  if (level.some((n) => forksOf(n.repo.id).some(mayRead)))
    truncated = true;
  return { root, size, truncated };
}
