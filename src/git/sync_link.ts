/**
 * The sync contract between two repositories that follow one another, for
 * every shape a network takes: a follower, a fork, a mirror, two forges
 * syncing both ways, a forge with several upstreams, a diamond.
 *
 * One link is one question and one action:
 *   `judgeLink`  where do the two tips stand, and what is the one action
 *                that reconciles them;
 *   `syncLink`   bring their tip in, and move our branch only when that is a
 *                fast-forward.
 *
 * Idempotent: the same tip taken twice is the second time a no-op, whichever
 * route it came by (a diamond lands once). Resumable: objects arrive by a
 * fetch into a staging ref that git writes whole or not at all, and the
 * branch moves by a compare-and-swap, so a sync cut off at any point leaves
 * the branch where it was and the next try finishes. Divergence never moves
 * a branch: it is staged and reported, with the action that reconciles it.
 *
 * Plain data in, plain data out; `source` is a path or URL the forge
 * computed (never user text) and refs are checked at the door.
 */

import { runGit } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";
import { mergeable, mergeBase } from "./merge.ts";

export type LinkState = "synced" | "behind" | "ahead" | "diverged";

/** What reconciles a link: nothing, take theirs, offer ours, merge, or keep both and decide. */
export type Reconcile = "none" | "fast-forward" | "offer" | "merge" | "keep-both";

export interface LinkJudgement {
  readonly state: LinkState;
  /** Commits on their side we do not have. */
  readonly behind: number;
  /** Commits on our side they do not have. */
  readonly ahead: number;
  /** For `diverged`: git merges the two without a decision. */
  readonly clean: boolean;
  /** For `diverged` and not clean: files both sides changed. */
  readonly conflicts: readonly string[];
  readonly action: Reconcile;
  /** Plain words for both sides to read. */
  readonly words: string;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The state, the one action that reconciles it, and the words both sides read,
 * from counts alone: the contract with no git in it, so a fork's relation here
 * and a link between forges say the same thing.
 */
export function describeLink(
  behind: number,
  ahead: number,
  clean: boolean,
  conflicts: readonly string[],
): LinkJudgement {
  const at = (state: LinkState, action: Reconcile, words: string): LinkJudgement => ({ state, behind, ahead, clean, conflicts, action, words });
  if (behind === 0 && ahead === 0) return at("synced", "none", "In sync: both sides are at the same commit.");
  if (ahead === 0) return at("behind", "fast-forward", `Behind by ${plural(behind, "commit")}: take them in, nothing of ours is lost.`);
  if (behind === 0) return at("ahead", "offer", `Ahead by ${plural(ahead, "commit")}: they do not have it yet; offer it as a pull.`);
  const counts = `${plural(behind, "commit")} there, ${plural(ahead, "commit")} here`;
  if (clean) return at("diverged", "merge", `Diverged (${counts}) but git merges the two cleanly: merge them.`);
  return at(
    "diverged",
    "keep-both",
    `Diverged (${counts}) and ${conflicts.length === 0 ? "git cannot merge them" : `both changed ${conflicts.join(", ")}`}: keep both and decide.`,
  );
}

/** Where two tips stand, both already present in `dir`. */
export async function judgeLink(dir: string, ours: string, theirs: string): Promise<LinkJudgement> {
  const unknown = (words: string): LinkJudgement => ({ state: "diverged", behind: 0, ahead: 0, clean: false, conflicts: [], action: "keep-both", words });
  if (!isSafeOid(ours) || !isSafeOid(theirs)) return unknown("A tip could not be read, so nothing was moved.");
  if (ours === theirs) return describeLink(0, 0, true, []);
  const count = async (range: string): Promise<number> => {
    const r = await runGit(["rev-list", "--count", range], { cwd: dir });
    return r.ok ? Number(r.value) || 0 : 0;
  };
  if ((await mergeBase(dir, ours, theirs)) === undefined) return unknown("The two sides share no history; keep both and choose which one to follow.");
  const [behind, ahead] = await Promise.all([count(`${ours}..${theirs}`), count(`${theirs}..${ours}`)]);
  if (ahead === 0 || behind === 0) return describeLink(behind, ahead, true, []);
  const merged = await mergeable(dir, ours, theirs);
  if (merged.ok) return describeLink(behind, ahead, true, []);
  return describeLink(behind, ahead, false, merged.error.kind === "conflict" ? merged.error.files : []);
}

export interface LinkSync {
  /** Whether our branch moved. */
  readonly moved: boolean;
  readonly from: string;
  readonly to: string;
  readonly judgement: LinkJudgement;
  /** Where their tip is held in our repository, for the action that follows. */
  readonly staged: string;
}

export type LinkError = "bad-ref" | "unreachable" | "raced";

export type LinkResult = { ok: true; value: LinkSync } | { ok: false; error: LinkError };

/**
 * Bring `source`'s `theirRef` into the repository at `dir` and move `ourRef`
 * to it when that is a fast-forward (or our branch is unborn). Their tip is
 * always held at `stageRef`, moved or not, so the one action that reconciles
 * a divergence has what it needs. Syncs to the same stage ref wait their turn.
 */
/**
 * Syncs into one repository's stage ref, one at a time. Two at once would
 * force-fetch the same ref and swap the same branch, and the loser would come
 * back as a refused lock or a lost swap that is no fault of the link; queued,
 * the second finds the first's work done and is the no-op it should be.
 * Keyed by repository and stage ref; the forge is one process.
 */
const queues = new Map<string, Promise<unknown>>();

export function syncLink(
  dir: string,
  ourRef: string,
  source: string,
  theirRef: string,
  stageRef: string,
): Promise<LinkResult> {
  const key = `${dir}\0${stageRef}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(() => syncOnce(dir, ourRef, source, theirRef, stageRef));
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

async function syncOnce(
  dir: string,
  ourRef: string,
  source: string,
  theirRef: string,
  stageRef: string,
): Promise<LinkResult> {
  if (![ourRef, theirRef, stageRef].every(isSafeRef) || !stageRef.startsWith("refs/") || source.startsWith("-") || source === "") return { ok: false, error: "bad-ref" };
  const fetched = await runGit(["fetch", "--no-tags", "--quiet", source, `+${theirRef}:${stageRef}`], { cwd: dir, timeoutMs: 120_000 });
  if (!fetched.ok) return { ok: false, error: "unreachable" };
  const read = async (ref: string): Promise<string | undefined> => {
    const r = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir });
    return r.ok ? r.value.trim() : undefined;
  };
  const to = await read(stageRef);
  if (to === undefined) return { ok: false, error: "unreachable" };
  const from = await read(ourRef);
  if (from === undefined) {
    const made = await runGit(["update-ref", ourRef, to, "0".repeat(40)], { cwd: dir });
    if (!made.ok) return { ok: false, error: "raced" };
    return { ok: true, value: { moved: true, from: "", to, judgement: await judgeLink(dir, to, to), staged: stageRef } };
  }
  const judgement = await judgeLink(dir, from, to);
  if (judgement.state !== "behind") return { ok: true, value: { moved: false, from, to: from, judgement, staged: stageRef } };
  // Compare-and-swap: if our branch moved since it was read, it is left as it is.
  const swapped = await runGit(["update-ref", ourRef, to, from], { cwd: dir });
  if (!swapped.ok) return { ok: false, error: "raced" };
  return { ok: true, value: { moved: true, from, to, judgement, staged: stageRef } };
}
