/**
 * Naming the crew teams on an issue (#2681), for a writer of its repository.
 * A mirror's issues are the origin's, so it is refused as every local write is.
 */

import type { App } from "../app.ts";
import { setIssueTeams, TEAMS_MAX, type IssueTeamsError } from "../core/issue_teams.ts";
import type { Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";

/** One sentence per refusal, said the same by the page, API, MCP tool and terminal. */
export const ISSUE_TEAMS_SAY: Record<string, string> = {
  too_many: `An issue names at most ${TEAMS_MAX} teams.`,
  no_such_team: "No such team.",
  mirrored:
    "This repository mirrors an origin — do it there, and the next sync brings it back.",
  unauthorized: "Sign in to name teams.",
  forbidden: "You need write access to name teams.",
  not_found: "No such issue.",
};

export function nameTeams(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  slugs: readonly string[],
): Result<string[], AccessError | "mirrored" | IssueTeamsError> {
  const who = requireWriter(app, actor, repo);
  if (!who.ok) return who;
  if (isMirror(app, repo)) return err("mirrored");
  const set = setIssueTeams(app.db, issue.id, slugs);
  if (!set.ok) return set;
  app.bus.append({
    kind: "issue.teams",
    repoId: repo.id,
    actorId: who.value.id,
    payload: { number: issue.number, teams: set.value },
  });
  return set;
}
