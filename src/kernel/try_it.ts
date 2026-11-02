/**
 * Four reviews in a week opened with "I did not run the preview" (#8889):
 * the reviewer could not tell what to exercise there. A pull that changes
 * what a person, an agent or a terminal can reach (a page, an API route, an
 * MCP tool, an action, a terminal screen) therefore says, in a commit
 * message, `Try: <what to open or call on the preview>`. The check cannot
 * read the pull description, so the line lives in a commit. It checks that
 * a way to try the change was written, not that it works.
 */

import type { Change } from "./pin_edits.ts";

const SURFACE = /^src\/(actions|web|http|tui)\/.+\.ts$/;
const TRY = /^Try:\s*\S[^\n]{9,}/im;

/** The reachable files a pull adds or edits (a deletion has nothing to try). */
export function surfaceChanged(changes: readonly Change[]): string[] {
  return changes.filter((c) => !c.status.startsWith("D") && SURFACE.test(c.path)).map((c) => c.path);
}

/** One line per problem: none when no surface changes or a commit says how to try it. */
export function tryItProblems(changes: readonly Change[], messages: readonly string[]): string[] {
  const touched = surfaceChanged(changes);
  if (touched.length === 0) return [];
  if (messages.some((m) => TRY.test(m))) return [];
  const shown = touched.slice(0, 3).join(", ") + (touched.length > 3 ? ` and ${touched.length - 3} more` : "");
  return [
    `rule "say how to try it on the preview": this pull changes ${shown} but no commit message has a "Try: <what to open or call on the preview>" line (10+ characters)`,
  ];
}
