/** Run the radar for one repository: read package.json at the default branch's tip, ask upstream, store. */

import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import type { Repo } from "../core/repos.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { readPins, type Pin } from "./pins.ts";
import { refreshRadar, type Lookup } from "./radar.ts";

export async function pinsOf(app: App, repo: Repo): Promise<Pin[]> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return [];
  const text = await readFileAt(dir, tip, "package.json");
  return text === undefined ? [] : readPins(text);
}

export async function runRadar(app: App, repo: Repo, lookup: Lookup): Promise<number> {
  return refreshRadar(app.db, repo.id, await pinsOf(app, repo), lookup);
}
