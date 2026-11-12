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
  return plainWords(title.startsWith(DIRECTION_PREFIX) ? title.slice(DIRECTION_PREFIX.length) : title);
}

/** What only a developer reads: "#42", "PR 42", "pull request #42", "run #7", a run id, a numbered branch ("mason/12-menu-page"). */
const IDENTIFIER =
  "(?:(?:pull request|pull|PR|issue|run)\\s*#\\d+|#\\d+|\\brun[_-][0-9a-z]{6,}\\b|\\b[a-z][\\w.-]*\\/\\d+-[a-z0-9]+-[\\w./-]+)";
/** Words that only introduce an identifier ("as in PR #42", "on mason/12-x"). */
const INTRO = "(?:as in|as per|as seen in|see|see also|in|on|from|per|via|like|after|before|and|with|of|at|by|for|fixes|closes)";
const CLAUSE = new RegExp(`(?:[\\s,;:\\u2013\\u2014-]*(?:\\b${INTRO}\\s+)*${IDENTIFIER})+`, "gi");

/**
 * Words for a client: each identifier goes with the clause that introduces it,
 * so no fragment ("as in on") is left behind. A title that was mostly
 * identifiers leaves too little to read and comes back empty; the caller says
 * the app's name instead.
 */
export function plainWords(text: string): string {
  const kept = text
    .replace(CLAUSE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:\u2013\u2014-]+$/, "")
    .trim();
  return kept !== text.trim() && kept.split(" ").length < 2 ? "" : kept;
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
    const goal = directionText(issue.title) || repo.name;
    const says =
      run?.state === "running"
        ? `${agent.username} is working toward ${goal}`
        : run?.state === "queued"
          ? `${agent.username} is about to start on ${goal}`
          : `${agent.username} is ready to work toward ${goal}`;
    return { repo, who: agent.username, issueNumber: issue.number, says, busy: run?.state === "running" || run?.state === "queued" };
  });
}
