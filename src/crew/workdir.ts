/**
 * Where an agent's clones live: `<data>/crew/<agent>/<repo id>/<issue n>/`,
 * for as long as the pull is open. One file, so the runner, the dispatcher
 * and the sandbox policy agree on the layout without importing each other.
 */

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
