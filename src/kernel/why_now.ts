/**
 * The direction issue puts the pipeline first (#8839), so a new feature
 * says why it goes ahead of it. A feature is a file a pull adds, at any
 * depth, under an action, a page, an API route, an MCP tool or a terminal
 * screen; the pull's commits must then say either `Pipeline: #N` (it is
 * pipeline work) or `Why now: <reason>` (it goes ahead, and why). The check
 * cannot read the pull description, so the answer lives in a commit
 * message. It is a nudge, not a proof: it checks a reason was written, not
 * that it is a good one.
 */

import type { Change } from "./pin_edits.ts";

const FEATURE = /^src\/(actions|web\/pages|http\/api|http\/mcp\/tools|tui)\/.+\.ts$/;
const PIPELINE = /^Pipeline:\s*#\d+/im;
const WHY_NOW = /^Why now:\s*\S[^\n]{14,}/im;

/** The files a pull adds that make a new feature. */
export function featuresAdded(changes: readonly Change[]): string[] {
  return changes.filter((c) => c.status.startsWith("A") && FEATURE.test(c.path)).map((c) => c.path);
}

/** One line per problem: none when no feature is added or a commit answers the direction. */
export function whyNowProblems(changes: readonly Change[], messages: readonly string[]): string[] {
  const added = featuresAdded(changes);
  if (added.length === 0) return [];
  if (messages.some((m) => PIPELINE.test(m) || WHY_NOW.test(m))) return [];
  return [
    `rule "say why it goes ahead of the pipeline": this pull adds ${added.join(", ")} but no commit message has a "Why now: <reason>" line (15+ characters) or a "Pipeline: #N" line`,
  ];
}
