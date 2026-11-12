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

const SURFACE = /^src\/(actions|web|http|tui|feed|view|cli|boards|search|display|story|devices)\/.+\.ts$/;
const TRY = /^Try:\s*\S[^\n]{9,}$/;
// A Try line that says nothing was tried, or nothing can be, is no line. A
// single word is hollow only when it is the whole clause (`Try: todo list…`
// is a real line about a todo page); the two confessions are hollow at the start.
const HOLLOW =
  /^Try:\s*(?:(?:n\/?a|none|nothing|tbd|todo|untested|not applicable|see (?:the )?(?:diff|code))(?=\s*(?:[,.;:\u2014]|$))|did not\b|didn't\b|not tried\b)/i;

/** The `Try:` lines of a message, one string each: each is judged alone. */
function tryLines(message: string): string[] {
  return message.split("\n").map((l) => l.trim()).filter((l) => /^Try:/i.test(l));
}

/** True when some line of the message is a real Try line. */
function hasRealTry(message: string): boolean {
  return tryLines(message).some((l) => TRY.test(l) && !HOLLOW.test(l));
}

/** The reachable files a pull adds or edits (a deletion has nothing to try). */
export function surfaceChanged(changes: readonly Change[]): string[] {
  return changes.filter((c) => !c.status.startsWith("D") && SURFACE.test(c.path)).map((c) => c.path);
}

/** One line per problem: none when no surface changes or a commit says how to try it. */
export function tryItProblems(changes: readonly Change[], messages: readonly string[]): string[] {
  const touched = surfaceChanged(changes);
  if (touched.length === 0) return [];
  if (messages.some(hasRealTry)) return [];
  const shown = touched.slice(0, 3).join(", ") + (touched.length > 3 ? ` and ${touched.length - 3} more` : "");
  return [
    `rule "say how to try it on the preview": this pull changes ${shown} but no commit message has a "Try: <what to open or call on the preview>" line (10+ characters) that names something to open or call, not "n/a" or "not tried"`,
  ];
}
