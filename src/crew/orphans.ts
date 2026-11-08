/**
 * Clones nothing waits for (#5697). A clone lives for as long as its pull is
 * open, and the runner and the dispatcher remove it when the pull lands or
 * closes. A run that ended without a pull, a forge that was down when the
 * pull closed, or a clone that would not go leaves one behind, and the state
 * volume fills (`Disk is nearly full`). This is the net under them: it lists
 * `<crew>/<agent>/<repo id>/<n>/` and removes those `keep` does not claim.
 */

import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getIssue } from "../core/issues.ts";
import { listPulls } from "../core/pulls.ts";
import { listActive } from "../core/runs.ts";

const dirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

/**
 * What a clone leaves beside itself: `<n>.broken-<ts>`, a clone moved aside,
 * and `<n>.run-<id>`, a run's own clone when another held the issue's. Both
 * are junk once no live run holds them (#8219).
 */
const ASIDE = /^[1-9]\d*\.(?:broken-\d+|run-[A-Za-z0-9]+)$/;

/**
 * Remove every clone `keep(agent, repoId, number)` is false for, and every
 * leftover beside one that `held(dir)` does not name; how many went.
 */
export async function sweepOrphanClones(
  crewDir: string,
  keep: (agent: string, repoId: string, number: number) => boolean,
  held: (dir: string) => boolean = () => false,
): Promise<number> {
  let swept = 0;
  for (const agent of dirs(crewDir)) {
    for (const repoId of dirs(join(crewDir, agent))) {
      for (const name of dirs(join(crewDir, agent, repoId))) {
        const path = join(crewDir, agent, repoId, name);
        if (ASIDE.test(name)) {
          if (held(path)) continue;
          try {
            await rm(path, { recursive: true, force: true });
            swept++;
          } catch {
            // tried again by the next sweep
          }
          continue;
        }
        if (!/^[1-9]\d*$/.test(name)) continue;
        if (keep(agent, repoId, Number(name))) continue;
        try {
          await rm(join(crewDir, agent, repoId, name), { recursive: true, force: true });
          swept++;
        } catch {
          // a leftover process still writes there; the next sweep tries again
        }
      }
    }
  }
  return swept;
}

/** The task number a branch `<agent>/<n>-…` names, if it does. */
function taskOf(agent: string, branch: string): number | undefined {
  if (!branch.startsWith(`${agent}/`)) return undefined;
  const m = /^(\d+)(?:-|$)/.exec(branch.slice(agent.length + 1));
  return m === null ? undefined : Number(m[1]);
}

/**
 * What still claims a clone: its issue is open, a run is queued or working
 * on it, or an open pull of the agent's branch for it. `repoId` is the
 * directory name `workdirFor` gives the repository: the db's `repo.id`.
 */
export function claimedClones(db: Database): (agent: string, repoId: string, number: number) => boolean {
  return (agent, repoId, number) => {
    // Read per clone, not once per sweep: the sweep awaits many removals, and
    // a run queued meanwhile for a just-closed issue must keep its clone.
    const active = listActive(db, "agent");
    if (getIssue(db, repoId, number)?.state === "open") return true;
    if (active.some((r) => r.repoId === repoId && taskOf(agent, r.branch) === number)) return true;
    return listPulls(db, repoId, { state: "open" }).some((p) => taskOf(agent, p.headBranch) === number);
  };
}
