/**
 * The forge's own repository (`FORGE_REPO`), when it is public: the one the
 * changelog reads and the one security.txt sends a stranger to.
 */

import type { App } from "../app.ts";
import { getRepo, type Repo } from "./repos.ts";

export function publicForgeRepo(app: App): Repo | undefined {
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  const repo = owner === "" || name === "" ? undefined : getRepo(app.db, owner, name);
  return repo !== undefined && repo.visibility === "public" ? repo : undefined;
}
