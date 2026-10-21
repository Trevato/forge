/**
 * Stop mirroring a migrated repository to its source (#3408). The only way
 * out of a mirror; the source is left exactly as it is.
 */

import type { App } from "../app.ts";
import { deleteMirrorTarget } from "../core/migrate_mirror.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

export function stopMirroring(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<boolean, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return err("not_found");
  return ok(deleteMirrorTarget(app.db, repo.id));
}
