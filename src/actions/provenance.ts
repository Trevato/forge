/**
 * "Show where this came from" (#3293): a repository's admin turns the
 * migrated-from line on or off. Off hides it on every page, in the
 * terminal and in the API's and MCP's fields; the record stays, so on
 * brings it back as it was.
 */

import type { App } from "../app.ts";
import { getProvenance, setProvenanceShown } from "../core/provenance.ts";
import type { Repo } from "../core/repos.ts";
import { settingMoved } from "../core/settings_changed.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

export interface ProvenanceAnswer {
  /** Whether the trail is shown, after this call. */
  readonly shown: boolean;
  /** Whether it was before it. */
  readonly was: boolean;
  /** Nothing changed: this was the plan. */
  readonly dryRun: boolean;
}

export function showProvenance(
  app: App,
  actor: User | undefined,
  repo: Repo,
  shown: boolean,
  dryRun = false,
): Result<ProvenanceAnswer, "not_found" | "no_provenance"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  // What the repository says about where it came from is a person's call,
  // like archiving it: an agent never changes it, nor plans to.
  if (admin.value.kind === "agent") return err("not_found");
  const trail = getProvenance(app.db, repo.id);
  if (trail === undefined) return err("no_provenance");
  const was = trail.shown;
  if (dryRun) return ok({ shown, was, dryRun });
  setProvenanceShown(app.db, repo.id, shown);
  app.bus.append({
    kind: "repo.settings_updated",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { changed: settingMoved("provenance", was, shown), shown },
  });
  return ok({ shown, was, dryRun });
}
