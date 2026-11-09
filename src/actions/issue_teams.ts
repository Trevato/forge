/**
 * Naming the crew teams on an issue (#2681), for a writer of its repository.
 * A mirror's issues are the origin's, so it is refused as every local write is.
 */

import type { App } from "../app.ts";
import { setIssueTeams, TEAMS_MAX, teamsHolding, type IssueTeamsError } from "../core/issue_teams.ts";
import type { Issue } from "../core/issues.ts";
import { openPullPileRows, pullsByIssueIds } from "../core/pulls.ts";
import { canRead, getReposByIds, type Repo } from "../core/repos.ts";
import { mayView } from "../core/sealed.ts";
import { listTeams } from "../core/teams.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { MIRRORED_DO_IT_THERE } from "./mirror_words.ts";
import { announceIssueTeamWaits } from "./team_waits.ts";

/** One sentence per refusal, said the same by the page, API, MCP tool and terminal. */
export const ISSUE_TEAMS_SAY: Record<string, string> = {
  too_many: `An issue names at most ${TEAMS_MAX} teams.`,
  no_such_team: "No such team.",
  mirrored: MIRRORED_DO_IT_THERE,
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
  announceIssueTeamWaits(app, repo, issue.number, who.value.id);
  return set;
}

/** The most pulls one answer lists. */
export const WAITING_MAX = 50;

export interface WaitingPull {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** When the pull was opened (ISO), the age it has waited from. */
  readonly since: string;
}

/**
 * The open pulls a crew team's review still holds (`teamsHolding`, the merge
 * gate's own question), oldest first, at most `limit`, and only those `actor`
 * may read (repository and sealed-issue rules). `team` is a crew-team slug or
 * name; crew teams are forge-wide, so no organization narrows the answer. One
 * function for the MCP tool and the terminal.
 */
export function pullsWaitingOn(
  app: App,
  actor: User | undefined,
  team: string,
  limit = WAITING_MAX,
): Result<WaitingPull[], "not_found"> {
  const db = app.db;
  const wanted = team.trim().toLowerCase();
  const crew = listTeams(db).find((t) => t.slug === wanted || t.name.toLowerCase() === wanted);
  if (!crew) return err("not_found");
  const rows = openPullPileRows(db);
  const repos = getReposByIds(db, [...new Set(rows.map((r) => r.repoId))]);
  const readable = new Map<string, boolean>();
  const visible = rows.filter((r) => {
    const repo = repos.get(r.repoId);
    if (repo === undefined) return false;
    let may = readable.get(r.repoId);
    if (may === undefined) readable.set(r.repoId, (may = canRead(db, repo, actor)));
    return may && mayView(db, repo, r, actor);
  });
  const found: WaitingPull[] = [];
  const BATCH = 100;
  for (let i = 0; i < visible.length; i += BATCH)
    for (const p of pullsByIssueIds(db, visible.slice(i, i + BATCH).map((r) => r.id))) {
      if (!teamsHolding(db, p).some((v) => v.team === crew.slug)) continue;
      const repo = repos.get(p.repoId)!;
      found.push({ repo: `${repo.ownerName}/${repo.name}`, number: p.number, title: p.title, since: p.createdAt });
    }
  // Oldest first, stated here and not left to the query's order.
  found.sort((a, b) =>
    a.since < b.since ? -1 : a.since > b.since ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number,
  );
  return ok(found.slice(0, limit));
}
