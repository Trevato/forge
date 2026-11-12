/**
 * Detach a fork from its parent (#7452): repack so the fork owns every
 * object it borrowed through alternates, drop the link (`detachFork`, the
 * same step the delete path takes), then forget the parent. Planned first,
 * like archive. The repack can take minutes on a big history, so it runs
 * off the request path; its phase is kept here, per process, and the
 * Settings card and the MCP read it back. Git stays the truth: a restart
 * mid-repack leaves the parent named and the alternates file in place, and
 * asking again finishes the job.
 */

import type { App } from "../app.ts";
import { clearForkParent, forkParentFor, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { detachFork, hasAlternates, repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";
import { DETACH_STAYS, DETACH_STOPS } from "./detach_words.ts";

const log = createLog("detach");

/** A detach under way, or the last one that failed. Gone once it lands. */
export interface DetachJob {
  readonly phase: "repacking" | "failed";
  readonly startedAt: string;
  /** Why it failed; empty while repacking. */
  readonly message: string;
  /** Settles when the job does; for tests and for whoever waits. */
  readonly done: Promise<void>;
}

/**
 * One entry per fork that is detaching or whose last detach failed; a
 * failure stays until the next try lands. So it is bounded by the number of
 * forks in this forge, and empties on restart.
 */
const jobs = new Map<string, DetachJob>();

/** The detach under way on this repository, or the last that failed. */
export function detachJob(repoId: string): DetachJob | undefined {
  return jobs.get(repoId);
}

export interface DetachPlan {
  /**
   * owner/name of the parent, only while `actor` may read it
   * (`forkParentFor`); null when they may not, or its row is gone.
   */
  readonly parent: string | null;
  /** Whether the fork still borrows objects, so a repack copies them in. */
  readonly borrows: boolean;
  readonly dryRun: boolean;
}

export type DetachError = "not_found" | "not_a_fork" | "running";

/**
 * Plan (dryRun) or start a detach. A repository admin's, never an agent's.
 * Starting answers at once; the repack and the parent's removal follow.
 */
export async function detachFromParent(
  app: App,
  actor: User | undefined,
  repo: Repo,
  dryRun: boolean,
): Promise<Result<DetachPlan, DetachError>> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok || admin.value.kind === "agent") return err("not_found");
  if (repo.forkParentId === null) return err("not_a_fork");
  const parentId = repo.forkParentId;
  const row = forkParentFor(app.db, repo, actor);
  const parent = row === undefined ? null : `${row.ownerName}/${row.name}`;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const plan = { parent, borrows: await hasAlternates(dir), dryRun };
  if (dryRun) return ok(plan);
  if (jobs.get(repo.id)?.phase === "repacking") return err("running");
  const startedAt = new Date().toISOString();
  const done = run(app, repo, dir, admin.value.id, parentId, startedAt);
  jobs.set(repo.id, {
    phase: "repacking",
    startedAt,
    message: "",
    done,
  });
  return ok(plan);
}

async function run(
  app: App,
  repo: Repo,
  dir: string,
  actorId: string,
  parentId: string,
  startedAt: string,
): Promise<void> {
  // Yield first, so the job is recorded before anything can finish it.
  await Promise.resolve();
  const detached = await detachFork(dir);
  if (!detached.ok) {
    log.error("detach failed", {
      repo: `${repo.ownerName}/${repo.name}`,
      stderr: detached.error.stderr,
    });
    jobs.set(repo.id, {
      phase: "failed",
      startedAt,
      message: failureLine(detached.error.stderr),
      done: Promise.resolve(),
    });
    return;
  }
  clearForkParent(app.db, repo.id);
  jobs.delete(repo.id);
  // Every reader of the fork reads this event, and not every one may read
  // the parent: its id, never its name.
  app.bus.append({
    kind: "repo.detached",
    repoId: repo.id,
    actorId,
    payload: { parentId },
  });
}

/** git's first line about it, short: the card says it, the log keeps the rest. */
function failureLine(stderr: string): string {
  const line = stderr.trim().split("\n")[0] ?? "";
  return line === "" ? "git could not repack it" : line.slice(0, 200);
}

/** The plan in one sentence, for the terminal's confirm and the MCP. */
export function detachPlanWords(plan: DetachPlan): string {
  const parent = plan.parent ?? "its parent";
  return `${plan.borrows ? `Copies every object it borrows from ${parent} into its own store, drops the link, then forgets` : `Borrows nothing from ${parent}; forgets`} the parent. ${DETACH_STAYS} ${DETACH_STOPS} There is no undo.`;
}

/** Where a detach stands, in words; null when none is under way or failed. */
export function detachPhaseWords(job: DetachJob | undefined, ago: (iso: string) => string): string | null {
  if (job === undefined) return null;
  return job.phase === "repacking"
    ? `repacking, started ${ago(job.startedAt)}`
    : `stopped: ${job.message}`;
}
