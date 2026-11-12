/**
 * Waking the work (#11515). A run that could not start for want of a model
 * key, or that a spend limit stopped, parks its issue; the owner then adds a
 * key or raises a limit, and the issue should be tried again without anyone
 * asking. A person's word on an issue starts its strike count from zero
 * (`parks.ts`), so waking is that word: one comment, in the acting admin's
 * name, on each issue whose newest park since the last word was for the
 * means. Once per park: the comment is the word, so a second wake finds
 * nothing left to wake.
 */

import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { PARK_LIKE } from "../core/done_on_main.ts";
import { getIssueById } from "../core/issues.ts";
import { getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isLimitStop, NO_ACCOUNT_SAID, NO_KEY_SAID } from "./forge_budget.ts";
import { parkReasons } from "./parks.ts";

/** Why the issues were woken, for the comment they get. */
export type WakeCause = "key" | "limit";

const WORDS: Record<WakeCause, string> = {
  key: "A model key was added",
  limit: "A spend limit was raised",
};

/** Park reasons a new key can fix: the exact words the runner writes for want of a key, an account or a grant. */
const NO_GRANT = /the account `[^`]+` has no model grant; an admin can grant one/;
const MEANS: Record<WakeCause, (reason: string) => boolean> = {
  key: (r) => r.includes(NO_KEY_SAID) || r.includes(NO_ACCOUNT_SAID) || NO_GRANT.test(r),
  limit: isLimitStop,
};

/** What a wake looks at, at most: issues carrying a park for the cause, newest first. A request stays small. */
export const WAKE_MAX = 200;

/** SQL pre-filter on the park text, so only issues that have such a park are read. */
const CANDIDATES: Record<WakeCause, string> = {
  key: "(c.body LIKE '%has no model key%' OR c.body LIKE '%has no model account%' OR c.body LIKE '%has no model grant%')",
  limit: "c.body LIKE '%limit ($%stopped the run%'",
};

/** Un-park every issue parked for the owner's means; how many were picked back up. */
export function wakeParked(app: App, by: User, cause: WakeCause): number {
  const rows = app.db
    .query<{ id: string }, [number]>(
      `SELECT i.id, MAX(c.created_at) AS at
         FROM comment c JOIN issue i ON i.id = c.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE i.state = 'open' AND i.kind = 'issue' AND r.autonomy = 'autonomous'
          AND c.body LIKE '${PARK_LIKE}' AND ${CANDIDATES[cause]}
        GROUP BY i.id ORDER BY at DESC LIMIT ?1`,
    )
    .all(WAKE_MAX);
  let woken = 0;
  for (const { id } of rows) {
    const issue = getIssueById(app.db, id);
    const repo = issue === undefined ? undefined : getRepoById(app.db, issue.repoId);
    if (issue === undefined || repo === undefined) continue;
    const reasons = parkReasons(app.db, repo, issue.id);
    const last = reasons[reasons.length - 1];
    if (last === undefined || !MEANS[cause](last)) continue;
    // A sealed issue's comment is seen only where the issue is (`core/sealed.ts`).
    const said = addComment(app, by, repo, issue, `${WORDS[cause]}, so the crew picks this back up and tries it again.`);
    if (said.ok) woken += 1;
  }
  return woken;
}

/** The owner's line after a wake: nothing when nothing woke. */
export const wokeWords = (n: number): string => (n === 0 ? "" : `${n} ${n === 1 ? "issue" : "issues"} picked back up.`);
