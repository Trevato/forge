/**
 * A repository's pillars' ask-to-live, for the surfaces that show it (the map,
 * the milestones, their data). Opt-in, so only the callers that print it pay
 * for it; it reads which deploys carry which merges from `deploy_pull` and
 * runs no git.
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

export function askToLiveFor(
  app: App,
  repo: Repo,
  view: PillarView | undefined,
  user: User | undefined,
): AskToLiveCount[] {
  if (view === undefined) return [];
  return askToLiveOf(
    app.db,
    repo,
    view,
    sealedScope(app.db, repo, user),
  );
}
