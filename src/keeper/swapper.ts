/**
 * The keeper's hands without a cluster (#8042): the `Deployer` that swaps a
 * tree in place instead of patching a Deployment's image. A reference is
 * `tree/<sha>:<version>`; setting it checks the commit out under
 * `releases/<sha>/`, starts it beside this process on the same port
 * (`release/swap.ts`, SO_REUSEPORT, handed over once health names the commit),
 * and drains this process. Nothing here needs a registry, a Forgejo, a
 * Kubernetes API or a person's machine.
 *
 * - **Known good**: before the first swap away from a tree, that tree is
 *   pinned under `releases/<commit>/` (an image's own tree included), so the
 *   rollback is the same swap to a tree that was already live.
 * - **Dependencies**: a release is swapped in only when its package.json
 *   names no dependency. Its directory has no node_modules, and installing
 *   into it before preflight would run a package manager's scripts inside the
 *   forge; so a tree that adds one is not cut (`admits`), and the line says a
 *   new image is needed. The image only has to be a base.
 * - **Rollback**: a tree that has served is swapped back to only when it
 *   knows every migration the live database has applied (the guard of
 *   `--rollback`, `release/rollback.ts`); an older tree is refused and the
 *   line says so, since this forge has no down-migration.
 * - **Refusals**: a commit refused (dependency, red preflight) is remembered
 *   per sha and logged once, so the next minute does not check it out and boot
 *   a preflight again.
 * - **Pruning** (#11801): `store` lists the trees under `releases/<sha>/`
 *   by the directory's mtime, which `checkoutRelease` sets when it writes the
 *   tree and touches each time the same commit is checked out again (a swap,
 *   a rollback, a landing); a tree only pinned as good is not touched. It
 *   removes one by commit, synchronously, inside the keeper's tick (a few
 *   trees once a release, so the tick is not held long);
 *   the keeper decides which (`prune.ts`). The tree this process runs and the
 *   one it handed over to are never removed, whatever it is asked.
 * - **Restart**: once verified, `verified` keeps the tree as the last good
 *   release over this image's version (`release/launch.ts`), so a pod
 *   restart comes back on it, not on the older image's version.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, type Result } from "../kernel/result.ts";
import { releaseDir, releasesRoot, type Verdict } from "../release/checkout.ts";
import { keepGood } from "../release/launch.ts";
import { liveSchema, releaseSchema } from "../release/rollback.ts";
import { beginSwap, endSwap, startRelease, swapBlocked } from "../release/swap.ts";
import type { Deployer, ReleaseStore } from "./deploy.ts";
import type { Stored } from "./prune.ts";

const REF = /^tree\/([0-9a-f]{40}):([0-9A-Za-z][0-9A-Za-z.+_-]{0,63})$/;
const TREE_PARTS = ["src", "package.json", "tsconfig.json"];
/** A tree that has served: a rollback target, not a candidate, so it is not preflighted again. */
const LIVE_MARK = ".was-live";
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SHA = /^[0-9a-f]{40}$/;

/** The commit a swapper ref (`tree/<sha>:<version>`) names; undefined for any other ref. */
export const treeOf = (ref: string): string | undefined => REF.exec(ref)?.[1];

export interface SwapperInput {
  readonly dataDir: string;
  readonly port: number;
  /** The tree this process runs from: the directory holding `src/main.ts`. */
  readonly treeRoot: string;
  readonly version: () => string;
  readonly commit: () => string | null;
  readonly env: Record<string, string | undefined>;
  /** Write `sha`'s tree to `releases/<sha>/`; the directory. */
  readonly checkout: (sha: string) => Promise<Result<string, string>>;
  readonly preflight: (dir: string) => Promise<Verdict>;
  /** Let go of the port and drain, once the new tree is well. */
  readonly drain: () => void;
  readonly probe?: Readonly<Record<string, string>>;
  readonly budgetMs?: number;
  /** Told how long each stage of a forward swap took, just before this process drains (#11839). */
  readonly timed?: (t: { buildMs: number; proofMs: number; switchMs: number }) => void;
  readonly now?: () => number;
}

/** Why `dir`'s package.json cannot run without an install; undefined when it names no dependency. */
export function dependencyChange(dir: string): string | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return "the tree has no readable package.json";
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (typeof deps === "object" && deps !== null && Object.keys(deps).length > 0)
      return `${field} names ${Object.keys(deps).slice(0, 3).join(", ")}: a dependency change needs a new image, which is the base this swaps over`;
  }
  return undefined;
}

export function swapper(i: SwapperInput): Deployer {
  const now = i.now ?? Date.now;
  /** Set once this process has handed over: what it then reports as running, so the keeper does not promote again. */
  let handedTo: string | undefined;
  const admitted = new Set<string>();
  /** Commits refused for good (their tree does not change), with the reason. */
  const refused = new Map<string, string>();

  const here = (): string => {
    const commit = i.commit();
    if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("the running commit is not stamped, so there is no known good tree to name");
    return `tree/${commit}:${i.version()}`;
  };

  /** Keep the running tree where a rollback finds it. */
  function pin(): void {
    const commit = i.commit();
    if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) return;
    const target = releaseDir(i.dataDir, commit);
    if (existsSync(target)) {
      writeFileSync(join(target, LIVE_MARK), "");
      return;
    }
    const staging = `${target}.pin-${process.pid}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const part of TREE_PARTS)
      if (existsSync(join(i.treeRoot, part))) cpSync(join(i.treeRoot, part), join(staging, part), { recursive: true });
    writeFileSync(join(staging, LIVE_MARK), "");
    renameSync(staging, target);
  }

  const refuse = (sha: string, why: string): Result<string, string> => {
    refused.set(sha, why);
    console.error(`keeper: ${sha.slice(0, 12)} is not swapped in: ${why}`);
    return err(why);
  };

  /** Milliseconds of the stages the last `prepare` ran; a stage it skipped (already admitted) counts 0. */
  let stages = { buildMs: 0, proofMs: 0 };

  async function prepare(sha: string, forward: boolean): Promise<Result<string, string>> {
    stages = { buildMs: 0, proofMs: 0 };
    const before = forward ? refused.get(sha) : undefined;
    if (before !== undefined) return err(before);
    const built = now();
    const out = await i.checkout(sha);
    stages.buildMs = now() - built;
    if (!out.ok) return err(`checkout failed: ${out.error}`);
    if (!forward) return out;
    if (admitted.has(sha)) return out;
    const deps = dependencyChange(out.value);
    if (deps !== undefined) return refuse(sha, deps);
    const proving = now();
    const verdict = await i.preflight(out.value);
    stages.proofMs = now() - proving;
    if (!verdict.ok) return refuse(sha, `preflight failed: ${verdict.line}`);
    admitted.add(sha);
    return out;
  }

  /** The guard of `--rollback`: a tree that knows fewer migrations than the live database has applied does not run on it. */
  async function schemaRefusal(sha: string, dir: string): Promise<string | undefined> {
    const known = await releaseSchema(dir);
    const live = liveSchema(i.dataDir);
    if (known === undefined) return live === 0 ? undefined : `${sha} has no readable schema; not rolling back to it`;
    return known < live ? `${sha} predates schema ${live}; rolling back would need a down-migration` : undefined;
  }

  const store: ReleaseStore = {
    async list() {
      const root = releasesRoot(i.dataDir);
      if (!existsSync(root)) return [];
      const found: Stored[] = [];
      for (const name of readdirSync(root)) {
        if (!SHA.test(name)) continue;
        try {
          found.push({ id: name, at: statSync(join(root, name)).mtimeMs });
        } catch {
          // Removed between the listing and the look.
        }
      }
      return found;
    },
    idOf: treeOf,
    async remove(sha) {
      if (!SHA.test(sha)) throw new Error("not a commit id");
      if (sha === i.commit() || (handedTo !== undefined && REF.exec(handedTo)?.[1] === sha)) throw new Error(`${sha.slice(0, 12)} is running`);
      rmSync(releaseDir(i.dataDir, sha), { recursive: true, force: true });
    },
  };

  return {
    store,
    async image() {
      return handedTo ?? here();
    },
    refFor: (version, sha) => `tree/${sha}:${version}`,
    async admits(sha) {
      // Nothing is cut that this process could not swap in: the same refusals as the swap itself.
      const blocked = swapBlocked();
      if (blocked !== undefined) return blocked;
      const r = await prepare(sha, true);
      return r.ok ? undefined : r.error;
    },
    async setImage(ref) {
      const m = REF.exec(ref);
      if (m === null) throw new Error("not a tree reference");
      const [, sha, version] = m as unknown as [string, string, string];
      if (handedTo === ref) return;
      // A tree that has served (pinned when it was swapped away from) is a rollback and is not checked again; any other is admitted, as at the cut.
      const backward = existsSync(join(releaseDir(i.dataDir, sha), LIVE_MARK));
      const dir = await prepare(sha, !backward);
      if (!dir.ok) throw new Error(dir.error);
      if (backward) {
        const stopped = await schemaRefusal(sha, dir.value);
        if (stopped !== undefined) throw new Error(stopped);
      }
      const turn = beginSwap();
      if (!turn.ok) throw new Error(turn.line);
      let swapped = false;
      try {
        pin();
        const env = { ...i.env, FORGE_DATA: i.dataDir };
        const switching = now();
        const started = await startRelease({
          dir: dir.value,
          sha,
          port: i.port,
          env,
          version,
          ...(i.probe === undefined ? {} : { probe: i.probe }),
          ...(i.budgetMs === undefined ? {} : { budgetMs: i.budgetMs }),
        });
        if (!started.ok) throw new Error(started.line);
        swapped = true;
        if (!backward) i.timed?.({ ...stages, switchMs: now() - switching });
      } finally {
        endSwap(swapped);
      }
      handedTo = ref;
      i.drain();
    },
    verified(version) {
      const commit = i.commit();
      const base = i.env["FORGE_BASE_VERSION"] || i.env["FORGE_VERSION"] || null;
      if (commit === null || base === null) return;
      keepGood(i.dataDir, i.treeRoot, version, commit, now(), base);
    },
  };
}
