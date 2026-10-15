/**
 * The full tier on land (#1198): before a green pull is merged, the whole
 * gate runs once on what the merge would be — the pull with its base — so
 * what the fast tier left out is judged at last. Green lands; red names the
 * tests (`landVerdict`) and teaches the pull's next fast run.
 */

import type { App } from "../app.ts";
import { parseCheck } from "../apps/manifest.ts";
import { readFileAt } from "../apps/checkout.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { writeMergeTree } from "../git/merge.ts";
import { failuresOf } from "./failures.ts";
import { addLearned } from "./learned.ts";
import { checksFor } from "./service.ts";
import { landVerdict, type LandVerdict } from "./tiers.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

/**
 * `dir` is where the pull's objects are (`pullDir`). A repository whose
 * check has no fast tier already ran its whole check on this head, and a
 * forge with no checks service has nothing to run: both land.
 */
export async function gateOnLand(
  app: App,
  repo: Repo,
  pull: Pull,
  dir: string,
  baseTip: string,
): Promise<LandVerdict> {
  const checks = checksFor(app);
  if (checks === undefined || baseTip === "") return { lands: true };
  const [forgeJson, packageJson] = await Promise.all([
    readFileAt(dir, pull.headOid, "forge.json"),
    readFileAt(dir, pull.headOid, "package.json"),
  ]);
  const declared = parseCheck(forgeJson, packageJson);
  if (!declared.ok || declared.value === undefined || declared.value.fast === null)
    return { lands: true };
  const tree = await writeMergeTree(dir, baseTip, pull.headOid);
  if (!tree.ok) return { lands: true };
  const commit = await runGit(
    ["commit-tree", tree.value.treeOid, "-p", baseTip, "-p", pull.headOid, "-m", "full gate on land"],
    { cwd: dir, env: IDENTITY },
  );
  if (!commit.ok) return { lands: true };
  const done = await checks.gate(repo, pull, commit.value.trim());
  const failed = failuresOf(done.lines);
  const verdict = landVerdict(done.ok, failed.tests, failed.files);
  if (!verdict.lands) addLearned(app.config.dataDir, pull.id, verdict.learn);
  return verdict;
}
