/**
 * Where an agent's clones live: `<data>/crew/<agent>/<repo id>/<issue n>/`,
 * for as long as the pull is open. One file, so the runner, the dispatcher
 * and the sandbox policy agree on the layout without importing each other.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../core/agents.ts";
import type { Repo } from "../core/repos.ts";

export const crewRoot = (dataDir: string): string => join(dataDir, "crew");

export function workdirFor(
  dataDir: string,
  agent: Agent,
  repo: Repo,
  issueNumber: number,
): string {
  return join(
    crewRoot(dataDir),
    agent.user.username,
    repo.id,
    String(issueNumber),
  );
}

/**
 * Remove a clone without blocking the event loop: a leftover process still
 * writing into it makes a removal fail with ENOTEMPTY, so it is tried again
 * a few times, awaiting between tries. Rejects with the last error if the
 * clone will not go; the caller says so loudly. `remove` is the removal
 * itself, replaceable for a test.
 */
export async function removeClone(
  dir: string,
  tries = 5,
  delayMs = 100,
  remove: (dir: string) => Promise<unknown> = (d) =>
    rm(d, { recursive: true, force: true }),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(dir);
      return;
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
