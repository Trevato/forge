/**
 * Parking a pull the crew cannot finish, and the note a park leaves. Its own
 * module so `autonomy.ts` and the stale-red sweep both reach it without
 * importing each other.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, assignIssue, setIssueState } from "../actions/issues.ts";
import { getHold } from "../core/holds.ts";
import { getIssue, getIssueById, type Issue } from "../core/issues.ts";
import { closesFromBody, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { authorsInRepoPull } from "./authors_pull.ts";
import {
  PARK_NOTE,
  PARK_STRIKES,
  PLANNER_HINT,
  parkReason,
  parkReasons,
} from "./parks.ts";

const log = createLog("autonomy");

/** What happens to an issue the crew hands over, said once on the issue. */
const HANDED_OVER =
  "The planner splits it, replaces it with a fresh issue, or defers it; a person can also say what to try. Nothing starts here until then, and the board lists it.";

/**
 * What a park says on its issue. A first strike is the reason — and, when a
 * pull closed with it, a word to the planner. The strike that takes the
 * issue out of the crew's hands also says every reason since someone who
 * directs the crew last spoke, and whose it is now: an issue parked twice
 * is handed over, never dropped.
 */
export function strikeNote(
  db: Database,
  repo: Repo,
  issue: Issue,
  reason: string,
  hint = "",
): string {
  const note = `${PARK_NOTE}${reason}`;
  const reasons = [...parkReasons(db, repo, issue.id), parkReason(note)];
  if (reasons.length < PARK_STRIKES)
    return hint === "" ? note : `${note} ${hint}`;
  return [
    note,
    "",
    `Parked ${reasons.length === 2 ? "twice" : `${reasons.length} times`} since a person last spoke here, so it is the planner's now. Every reason:`,
    "",
    ...reasons.map((r, n) => `${n + 1}. ${r}`),
    "",
    HANDED_OVER,
  ].join("\n");
}

/**
 * Park a pull the crew cannot finish: close it with the reason, put its
 * issues back on the map unassigned with the same reason, and move on. A
 * repository on its own never waits for a person; a parked issue is the
 * planner's to split or drop on its next pass, and one parked twice is
 * handed to the planner with every reason (`strikeNote`). A pull a person
 * holds is not parked: closing it would hand its issue back to the crew, to
 * build the same change again beside the one that was told to wait. A
 * person's pull from a branch of the repository itself is not parked
 * either: closing it is its author's, and closed it would stop following
 * the pushes that answer its review (#7572).
 */
export function parkPull(
  app: App,
  repo: Repo,
  pull: Pull,
  why: string,
): boolean {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  if (getHold(app.db, pull.id) !== undefined) return false;
  if (authorsInRepoPull(pull)) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  const issue = getIssueById(app.db, pull.id);
  if (!issue || issue.state !== "open") return false;
  addComment(app, by, repo, issue, `${PARK_NOTE}${why}`);
  const closed = setIssueState(app, by, repo, issue, "closed", {
    reason: "parked",
  });
  if (!closed.ok) return false;
  for (const number of closesFromBody(pull.body)) {
    const about = getIssue(app.db, repo.id, number);
    if (!about || about.state !== "open") continue;
    if (about.assigneeId !== null) assignIssue(app, by, repo, about, null);
    addComment(
      app,
      by,
      repo,
      about,
      strikeNote(
        app.db,
        repo,
        about,
        `${why} (pull #${pull.number} closed).`,
        PLANNER_HINT,
      ),
    );
  }
  log.info("parked", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    why,
  });
  return true;
}
