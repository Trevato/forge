/**
 * A red main gets one fix issue, and nobody else is handed its test (#1971).
 * The sentinel files the fix as the vitals card's finding (`red:<repoId>`);
 * while that issue is open, an issue that quotes a test main fails is the
 * same work, and the autonomy loop does not hand it to a builder. Five
 * builders once wrote one line in parallel for want of this.
 */

import type { Database } from "bun:sqlite";
import { redMain } from "../checks/red_main.ts";
import type { Issue } from "../core/issues.ts";
import { keyPart } from "./sentinel.ts";

/** The open issue fixing this repository's red main, if the sentinel filed one. */
export function redFixIssue(db: Database, repoId: string): string | undefined {
  return (
    db
      .query<{ issue_id: string }, [string]>(
        `SELECT t.issue_id FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
          WHERE t.key = ?1 AND i.state = 'open' LIMIT 1`,
      )
      .get(`degraded:${keyPart(`red:${repoId}`)}`)?.issue_id ?? undefined
  );
}

/**
 * Whether `issue` is work the red main's fix issue already carries: main is
 * red, a fix issue is open and is not this one, and this one's title or
 * body quotes a test main fails.
 */
export function coveredByRedFix(
  db: Database,
  repoId: string,
  issue: Pick<Issue, "id" | "title" | "body">,
): boolean {
  const red = redMain(db, repoId);
  if (red === undefined || red.failing.length === 0) return false;
  const fix = redFixIssue(db, repoId);
  if (fix === undefined || fix === issue.id) return false;
  const text = `${issue.title}\n${issue.body}`;
  return red.failing.some((name) => text.includes(name));
}
