/**
 * The quarantine, as a pull: when the job moved files out of the gate, the
 * edited file goes up as one commit on a dated branch and a pull asks for it,
 * opened as the repository's owner like the crew's own proposals. Nobody
 * hand-edits the list; the pull body says which command did.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { proposeEdit } from "../actions/propose_edit.ts";
import { readFileAt } from "../apps/checkout.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("nightly");

export async function proposeQuarantine(
  app: App,
  repo: Repo,
  ran: { readonly dir: string; readonly oid: string },
  path: string,
  branchPrefix: string,
  now: number,
): Promise<string | undefined> {
  const was = await readFileAt(repoDir(app.reposRoot, repo.ownerName, repo.name), ran.oid, path);
  const edited = readFileSync(join(ran.dir, path), "utf8");
  if (was === undefined || was === edited) return undefined;
  const owner = getUserById(app.db, repo.ownerId);
  if (owner === undefined || owner.kind !== "user") return undefined;
  const branch = `${branchPrefix}/${new Date(now).toISOString().slice(0, 10)}`;
  const proposed = await proposeEdit(app, owner, repo, {
    base: repo.defaultBranch,
    branch,
    files: [{ path, content: edited }],
    message: "Quarantine the files the flake hunt found flaky",
    title: `Quarantine flaky tests (${branch})`,
    body: "Moved by `bun scripts/flake-hunt.ts quarantine`, not by hand: each file leaves the gate under the open `Flaky:` issue that carries its failure, seed and run.",
  });
  if (!proposed.ok) {
    log.warn("could not propose the quarantine", { branch, step: proposed.error.step, reason: proposed.error.reason });
    return undefined;
  }
  return branch;
}
