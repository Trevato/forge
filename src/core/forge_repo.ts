/**
 * The forge's own repository (`FORGE_REPO`), when it is public: the one the
 * changelog reads and the one security.txt sends a stranger to.
 */

import type { App } from "../app.ts";
import { forgeSource } from "../settings/forge_source.ts";
import { getRepo, type Repo } from "./repos.ts";

export function publicForgeRepo(app: App): Repo | undefined {
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  const repo = owner === "" || name === "" ? undefined : getRepo(app.db, owner, name);
  return repo !== undefined && repo.visibility === "public" ? repo : undefined;
}

/**
 * Whether `repo` is the forge's own source (`settings/forge_source.ts`): an
 * admin's setting, else `FORGE_REPO`. Names compare without case, as the
 * forge's own lookups do.
 */
export function isForgeSource(app: App, repo: Pick<Repo, "ownerName" | "name">): boolean {
  return isNamed(forgeSource(app.db, app.config.forgeRepo), repo);
}

/** The one match of a repository against a configured `owner/name`, without case. */
export function isNamed(own: string | undefined, repo: Pick<Repo, "ownerName" | "name">): boolean {
  return own !== undefined && own.toLowerCase() === `${repo.ownerName}/${repo.name}`.toLowerCase();
}

/**
 * How an app's production is shown. For the forge's own source the app is a
 * test copy that every pull previews from; its production is the forge
 * itself, at the canonical URL, so that is what is shown and `copy` is where
 * the test copy runs. Display only: nothing routes by this, and every other
 * repository is shown its app's own URL.
 */
export function shownProduction(
  app: App,
  repo: Pick<Repo, "ownerName" | "name">,
  url: string | undefined,
): { url: string | undefined; copy: string | undefined } {
  const home = app.config.url;
  if (url === undefined || home === undefined || !isForgeSource(app, repo)) return { url, copy: undefined };
  return { url: new URL(home).origin, copy: url };
}
