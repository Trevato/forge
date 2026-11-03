/**
 * One nightly job, once: the default branch exported to a directory of its
 * own, each step run in a cell (`apps/contain.ts`) that reaches the forge
 * and the registry and nothing else, the step's output kept in the log.
 * The token goes only to steps that report, as FORGE_TOKEN, which the hunt
 * script already drops from the environment of the tests it runs.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../app.ts";
import { exportTree } from "../apps/checkout.ts";
import { type CellSpec, cellsAvailable, resolveLimits, STEP_HOSTS } from "../apps/contain.ts";
import { childEnv, runStep } from "../apps/process.ts";
import type { Repo } from "../core/repos.ts";
import { repoDir } from "../git/repos.ts";
import { refTip } from "../git/read.ts";
import { createLog } from "../kernel/log.ts";
import type { Job } from "./jobs.ts";

const log = createLog("nightly");

export interface Ran {
  readonly dir: string;
  readonly oid: string;
  /** The labels of the steps that failed. */
  readonly failed: readonly string[];
}

export async function runJob(
  app: App,
  repo: Repo,
  job: Job,
  options: { readonly forgeUrl: string; readonly token: string; readonly signal: AbortSignal },
): Promise<Ran | { readonly error: string }> {
  const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const oid = await refTip(bare, `refs/heads/${repo.defaultBranch}`);
  if (oid === undefined) return { error: `no ${repo.defaultBranch} to check out` };
  const dir = join(app.config.dataDir, "nightly", `${job.name}-checkout`);
  mkdirSync(join(app.config.dataDir, "nightly"), { recursive: true });
  const exported = await exportTree(bare, oid, dir);
  if (!exported.ok) return { error: exported.error };

  const cells = await cellsAvailable();
  // Repository code, run unattended with a token in its hands: never without a cell.
  if (!cells.ok) return { error: `no cell to run it in: ${cells.reason}` };
  const cell: CellSpec = {
    dir,
    writable: [],
    home: `${dir}.home`,
    hide: [app.config.dataDir, process.env["HOME"] ?? "", tmpdir()],
    egress: [...STEP_HOSTS],
    reach: [options.forgeUrl],
    limits: resolveLimits("step", undefined),
    label: `nightly:${job.name}`,
  };
  const failed: string[] = [];
  for (const step of job.steps) {
    if (options.signal.aborted) break;
    const env = childEnv({
      FORGE_API: `${options.forgeUrl}/api/v1`,
      FORGE_REPO: `${repo.ownerName}/${repo.name}`,
      FORGE_RUN_URL: `${options.forgeUrl}/${repo.ownerName}/${repo.name}`,
      FORGE_CELL_CPUS: String(cell.limits.cpus),
      ...(step.reports ? { FORGE_TOKEN: options.token } : {}),
    });
    const ran = await runStep(step.label, step.command, {
      cwd: dir,
      env,
      log: (line) => log.info(line, { job: job.name }),
      signal: options.signal,
      timeoutMs: step.timeoutMs,
      cell,
    });
    if (ran.ok) continue;
    log.warn("step failed", { job: job.name, step: step.label, error: ran.error });
    failed.push(step.label);
    // Nothing runs without its dependencies.
    if (step.label === "install") break;
  }
  return { dir, oid, failed };
}
