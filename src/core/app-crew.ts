/**
 * Each app with the crew member on it, in one plain sentence (#10753). The
 * first-login card and the terminal's home both read it, so the two doors say
 * the same thing. Plain data in, plain data out: no markup here.
 */

import type { Database } from "bun:sqlite";
import { DIRECTION_PREFIX } from "../crew/autonomy.ts";
import { getIssueById } from "./issues.ts";
import type { Repo } from "./repos.ts";
import { getUserById } from "./users.ts";

export interface AppCrew {
  readonly repo: Repo;
  /** The crew member on the app's direction; null when nobody is. */
  readonly who: string | null;
  /** The direction's issue number, to open it; null with nobody on it. */
  readonly issueNumber: number | null;
  /** What `who` is doing, in words: "atlas is working toward Run Maria's bakery". */
  readonly says: string;
  /** An agent run is going or lined up. */
  readonly busy: boolean;
}

/** An issue title without the tracker's "Direction: " label. */
function directionText(title: string): string {
  return title.startsWith(DIRECTION_PREFIX) ? title.slice(DIRECTION_PREFIX.length).trim() : title.trim();
}

/** For each of `repos`: who is on its direction and what they are doing now, or that nobody is. */
export function appCrew(db: Database, repos: readonly Repo[]): readonly AppCrew[] {
  return repos.map((repo) => {
    const issue = repo.directionIssueId === null ? null : getIssueById(db, repo.directionIssueId);
    const agent =
      issue && issue.state === "open" && issue.assigneeId !== null ? getUserById(db, issue.assigneeId) : null;
    if (!issue || !agent) return { repo, who: null, issueNumber: null, says: "nobody is on it yet", busy: false };
    const run = db
      .query<{ state: string }, [string]>(
        "SELECT state FROM run WHERE issue_id = ?1 AND kind = 'agent' ORDER BY created_at DESC LIMIT 1",
      )
      .get(issue.id);
    const goal = directionText(issue.title);
    const says =
      run?.state === "running"
        ? `${agent.username} is working toward ${goal}`
        : run?.state === "queued"
          ? `${agent.username} is about to start on ${goal}`
          : `${agent.username} is ready to work toward ${goal}`;
    return { repo, who: agent.username, issueNumber: issue.number, says, busy: run?.state === "running" || run?.state === "queued" };
  });
}
