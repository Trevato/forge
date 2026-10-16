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
import { chainOfRepo, severChain } from "../spawn/chain.ts";
import { requireUser } from "./access.ts";
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
