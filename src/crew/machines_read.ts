/**
 * A repository's machines as the default branch declares them (#9418).
 * Read at the default branch's tip, never at the agent's own branch: a run
 * cannot widen the machine it runs in by editing `forge.json`.
 */
import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import type { Repo } from "../core/repos.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { NO_CONFIG, parseMachines, type MachineConfig } from "./machines.ts";

/** The declared machines, or the built-ins when there are none or they are invalid. */
export async function repoMachines(app: App, repo: Repo): Promise<MachineConfig> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return NO_CONFIG;
  const parsed = parseMachines(await readFileAt(dir, tip, "forge.json"));
  // A broken declaration must not stop the crew: the standard sandbox runs.
  return parsed.ok ? parsed.value : NO_CONFIG;
}
