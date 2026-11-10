/**
 * Four reviews in a week said "both doors missing" (#10628): a new page
 * without a terminal screen in `src/tui/` (entry where AGENTS.md says) and
 * without a `docs/features/<name>.md` how-to. A pull that adds a page
 * (`src/web/pages/*.ts`) therefore adds a terminal screen (a new file under
 * `src/tui/`) and a features doc, or says in a commit message
 * `No door: <why this page needs no terminal screen or how-to>`.
 */

import type { Change } from "./pin_edits.ts";

const PAGE = /^src\/web\/pages\/[^/]+\.ts$/;
const SCREEN = /^src\/tui\/.+\.ts$/;
const DOC = /^docs\/features\/[^/]+\.md$/;
const WAIVER = /^No door:\s*\S[^\n]{9,}/im;

const added = (changes: readonly Change[], re: RegExp) =>
  changes.filter((c) => c.status.startsWith("A") && re.test(c.path)).map((c) => c.path);

/** One line per problem: none when no page is added, both doors come with it, or a commit waives them. */
export function bothDoorsProblems(changes: readonly Change[], messages: readonly string[]): string[] {
  const pages = added(changes, PAGE);
  if (pages.length === 0) return [];
  if (messages.some((m) => WAIVER.test(m))) return [];
  const missing: string[] = [];
  if (added(changes, SCREEN).length === 0) missing.push("terminal screen in src/tui/ (entry where AGENTS.md says)");
  if (added(changes, DOC).length === 0) missing.push("docs/features/<name>.md how-to");
  if (missing.length === 0) return [];
  const shown = pages.slice(0, 3).join(", ") + (pages.length > 3 ? ` and ${pages.length - 3} more` : "");
  return [
    `rule "both doors": this pull adds ${shown} but no ${missing.join(" and no ")}; add them, or put a "No door: <why>" line (10+ characters) in a commit message`,
  ];
}
