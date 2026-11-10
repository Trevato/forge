/**
 * What a press on a fork's following does, once, for every door (page, API,
 * MCP, terminal): take the parent's updates and, when both sides changed the
 * same files, tell the crew; and sever a forge's link to the forge its code
 * came from. The doors only word the answer.
 */

import { NOT_A_MEMBER } from "../core/roles.ts";
import type { App } from "../app.ts";
import { DIRECTION_NOTE } from "../crew/direct.ts";
import { convergeFork, type Converge } from "../crew/converge.ts";
import { ARCHIVED_WHY, canAdmin, canWrite, forkParentFor, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { chainOfRepo, forgeLinkOf, FOLLOW_MODES, isFollowMode, setChainMode, severChain } from "../spawn/chain.ts";
import { FAMILY_WORDS } from "./family_words.ts";
import { FOLLOWS_NOTHING, followModeWords } from "./follow_words.ts";
import { FORK_FOLLOW_MODES, forkFollowMode, isForkFollowMode, setForkFollowMode, type ForkFollowMode } from "../core/fork_follow.ts";
import { requireUser } from "./access.ts";
import { takeFromParent, type Taken } from "../spawn/take.ts";
import { takeUpdates, type ForkSync, type TakeUpdatesError } from "./forks.ts";

export type TakeOrTell = Result<ForkSync & { merged: boolean }, TakeUpdatesError | Conflict>;

/** A conflict taken, with what the crew did about it. */
export interface Conflict {
  readonly kind: "conflict";
  readonly files: readonly string[];
  readonly converge: Converge;
}

/** Take updates; a conflict opens (or finds) the converge issue naming its files. */
export async function takeOrTell(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<TakeOrTell> {
  const took = await takeUpdates(app, actor, fork);
  if (took.ok || typeof took.error === "string" || took.error.kind !== "conflict") return took;
  const parent = forkParentFor(app.db, fork, actor);
  if (parent === undefined) return took;
  const converge = await convergeFork(app, fork, parent, actor);
  return err({ kind: "conflict", files: took.error.files, converge });
}

export type SeverError = "unauthorized" | "forbidden" | "not_following";

/** Cut a forge's link to its parent's code: the repository's owner only. Nothing is deleted. */
export async function severForge(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<string, SeverError>> {
  const who = requireUser(actor);
  if (!who.ok) return err("unauthorized");
  if ((await chainOfRepo(app, repo)) === undefined) return err("not_following");
  if (!canAdmin(app.db, repo, who.value) || !canWrite(app.db, repo, who.value)) return err("forbidden");
  const cut = await severChain(app);
  if (!cut.ok) return err("not_following");
  app.bus.append({
    kind: "forge.severed",
    repoId: repo.id,
    actorId: who.value.id,
    payload: { repo: `${repo.ownerName}/${repo.name}`, at: cut.value },
  });
  return ok(cut.value);
}

export type TakeForgeResult = Taken | { readonly kind: "current" };

/**
 * Bring the parent's new code as the one take pull (`takeFromParent`), by
 * hand and whatever the mode: the repository's admin only. A conflict opens
 * the converge issue; nothing behind is `current`. The default branch never moves.
 */
export async function takeForgeCode(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<TakeForgeResult, SeverError>> {
  const who = requireUser(actor);
  if (!who.ok) return err("unauthorized");
  const link = await forgeLinkOf(app);
  if (link === undefined || link.severedAt !== undefined || link.repo !== `${repo.ownerName}/${repo.name}`)
    return err("not_following");
  if (!canAdmin(app.db, repo, who.value) || !canWrite(app.db, repo, who.value)) return err("forbidden");
  return ok((await takeFromParent(app, link)) ?? { kind: "current" });
}

/** What a take did, in a sentence; `danger` for a conflict. */
export function takeForgeWords(r: TakeForgeResult): { tone?: "danger"; message: string } {
  if (r.kind === "pull")
    return { message: `${r.commits} commit${r.commits === 1 ? "" : "s"} from your parent ${r.commits === 1 ? "is" : "are"} in pull #${r.number}.` };
  if (r.kind === "conflict")
    return {
      tone: "danger",
      message: `Your parent's new code conflicts in ${r.files.join(", ")}${r.issue === null ? "" : `; see issue #${r.issue}`}.`,
    };
  return { message: "Already up to date." };
}

/** How a repository follows its parent now: the forge chain's record when it carries one, else the fork's own choice. */
export async function followModeOf(app: App, repo: Repo): Promise<ForkFollowMode> {
  const link = await forgeLinkOf(app);
  return link !== undefined && link.repo === `${repo.ownerName}/${repo.name}`
    ? link.mode
    : forkFollowMode(app.db, repo.id);
}

export type FollowModeError = SeverError | "invalid_mode" | "severed";

/** The one answer every door gives a refused mode change, with the status an HTTP door sends. */
export const FOLLOW_MODE_REFUSALS: Record<FollowModeError, { status: number; message: string }> = {
  unauthorized: { status: 401, message: "sign in to change how this forge follows its parent" },
  forbidden: { status: 403, message: "only this forge's owner can change how it follows" },
  not_following: { status: 404, message: FAMILY_WORDS.not_following },
  invalid_mode: { status: 422, message: `mode is one of: ${FORK_FOLLOW_MODES.join(", ")}; a spawned forge takes ${FOLLOW_MODES.join(" or ")} and severs instead of not following` },
  severed: { status: 409, message: "this forge is severed and follows nothing; there is no mode to change" },
};

/**
 * Choose how a fork follows its parent: the repository's admin only; the
 * record changes atomically. A plain fork takes any of `FORK_FOLLOW_MODES`;
 * a spawned forge's chain takes `tell-me` or `take-updates` and severs to
 * follow nothing.
 */
export async function setFollowMode(
  app: App,
  actor: User | undefined,
  repo: Repo,
  mode: unknown,
): Promise<Result<ForkFollowMode, FollowModeError>> {
  const who = requireUser(actor);
  if (!who.ok) return err("unauthorized");
  const carries = (await chainOfRepo(app, repo)) !== undefined;
  if (!carries && repo.forkParentId === null) return err("not_following");
  if (!canAdmin(app.db, repo, who.value) || !canWrite(app.db, repo, who.value)) return err("forbidden");
  if (!isForkFollowMode(mode)) return err("invalid_mode");
  if (carries) {
    if (!isFollowMode(mode)) return err("invalid_mode");
    const set = await setChainMode(app, mode);
    if (!set.ok) return err(set.error);
  } else {
    setForkFollowMode(app.db, repo.id, mode);
  }
  app.bus.append({
    kind: "forge.follow_mode",
    repoId: repo.id,
    actorId: who.value.id,
    payload: { repo: `${repo.ownerName}/${repo.name}`, mode },
  });
  return ok(mode);
}

/** The sentence every door answers a mode change with. */
export function followModeSaid(parent: Repo | undefined, mode: ForkFollowMode): string {
  const upstream = parent === undefined ? "its parent" : `${parent.ownerName}/${parent.name}`;
  const words = followModeWords(mode, upstream);
  return `${words.line}. ${words.reason}`;
}

/** What the crew did about a conflict, in a sentence; `danger` when nothing is in hand. */
export function convergeWords(
  outcome: Converge,
  parentName: string,
): { tone?: "danger"; message: string } {
  switch (outcome.kind) {
    case "queued":
      return {
        message: `${outcome.agent.user.username} is converging with ${parentName} on #${outcome.issue.number}; the proposal comes back as a pull.`,
      };
    case "working":
      return {
        message: `The crew is already converging on #${outcome.issue.number}.`,
      };
    case "proposed":
      return {
        message: `The crew's proposal is already open: pull #${outcome.pull.number}.`,
      };
    case "parked":
      return {
        tone: "danger",
        message: `The crew tried its limit on #${outcome.issue.number}; say there what to do.`,
      };
    case "nothing":
      return {
        message:
          outcome.relation?.state === "diverged"
            ? "They merge cleanly; Take updates does it without the crew."
            : "Nothing to converge.",
      };
    case "no_crew":
      return {
        tone: "danger",
        message:
          "Nobody is on the crew here; add someone under Settings → Crew.",
      };
    case "nobody":
      return {
        tone: "danger",
        message: "Nobody can open the converge issue here.",
      };
    case "forbidden":
      return { tone: "danger", message: DIRECTION_NOTE };
    case "not_member":
      return { tone: "danger", message: `Not started: ${NOT_A_MEMBER}.` };
    case "archived":
      return { tone: "danger", message: ARCHIVED_WHY };
    case "ceiling":
      return {
        tone: "danger",
        message: "The crew is at today's ceiling; it converges tomorrow.",
      };
  }
}
/**
 * What taking updates says when there was nothing to take. "Up to date"
 * only of a parent that is itself up to date: a frozen one may be far
 * behind its own upstream, and the take only knows the frozen copy.
 */
export function nothingNew(parent: Repo): string {
  const name = `${parent.ownerName}/${parent.name}`;
  return parent.detached === null
    ? `Already up to date with ${name}.`
    : `Nothing new from ${name}, which is frozen: its origin was disconnected, so upstream may have moved. Reconnect it.`;
}

/**
 * What a take said, for every door that words it the same: taken (moved or
 * merged), nothing new, refused, or a conflict with what the crew did about it.
 */
export function takeWords(
  took: TakeOrTell,
  fork: Repo,
  parent: Repo,
): { tone?: "danger"; message: string } {
  const parentName = `${parent.ownerName}/${parent.name}`;
  if (took.ok)
    return {
      message: !took.value.updated
        ? nothingNew(parent)
        : took.value.merged
          ? `Took ${parentName}'s updates: merged into ${fork.defaultBranch} at ${took.value.to.slice(0, 7)}.`
          : `Took ${parentName}'s updates: ${fork.defaultBranch} is at ${took.value.to.slice(0, 7)}.`,
    };
  const e = took.error;
  if (typeof e === "string")
    return {
      tone: "danger",
      message: e === "not_a_fork" ? FOLLOWS_NOTHING : "You need write access to take updates here.",
    };
  // A conflict is a tell for the crew (`takeOrTell`).
  if (e.kind === "conflict") {
    const files = `${e.files.length === 1 ? "One file needs" : `${e.files.length} files need`} a decision (${e.files.join(", ")})`;
    const words = "converge" in e ? convergeWords(e.converge, parentName) : { message: "" };
    return { tone: "danger", message: `${files}. ${words.message}` };
  }
  return {
    tone: "danger",
    message: e.kind === "moved" ? "Something moved while this was read; try again." : `Git could not take the updates: ${e.message}`,
  };
}
