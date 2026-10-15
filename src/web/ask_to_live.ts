/**
 * A repository's pillars' ask-to-live, for the surfaces that show it (the map,
 * the milestones, their data). Opt-in and async: it asks git which deploys
 * carry which merges, so only the callers that print it pay for it.
 */

import type { App } from "../app.ts";
import {
  askToLiveOf,
  type AskToLiveCount,
  type PillarView,
} from "../core/pillars.ts";
import type { Repo } from "../core/repos.ts";
import { sealedScope } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { reachesIn } from "../git/local.ts";
import { repoDir } from "../git/repos.ts";

export function askToLiveFor(
  app: App,
  repo: Repo,
  view: PillarView | undefined,
  user: User | undefined,
): Promise<AskToLiveCount[]> {
  if (view === undefined) return Promise.resolve([]);
  return askToLiveOf(
    app.db,
    repo,
    view,
    reachesIn(repoDir(app.reposRoot, repo.ownerName, repo.name)),
    sealedScope(app.db, repo, user),
  );
}
