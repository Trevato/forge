import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as ui from "../../src/web/ui.ts";

/**
 * Every component function `src/web/ui.ts` exports has `test/ui-spec/<name>.test.ts`,
 * or is named here. Shrink this list: write the spec, delete the name. Reasons
 * are in the comment: "text" returns a string or a number, not markup;
 * "size" is a control the stylesheet does not yet make 44 px on a thumb
 * (tabs 40, seg 28, a small button 36); "todo" is simply unwritten.
 */
const EXCLUDED: Record<string, string> = {
  // not markup
  timeAgo: "text", fileSize: "text", tokenCount: "text", queuedPhrase: "text", servedPhrase: "text",
  envPhrase: "text", envTone: "text", hueOf: "text", labelCss: "text", hintAttr: "attribute text", when: "helper",
  // stylesheet gaps the helper found
  tabs: "size", seg: "size", pager: "size", copyField: "size",
  // todo
  avatar: "todo", badge: "todo", card: "todo", chartBox: "todo", counts: "todo", dormantNote: "todo",
  dot: "todo", envActions: "todo", envFacts: "todo", envLine: "todo", envStateBadge: "todo",
  icon: "todo", keyHint: "todo", kbd: "todo", labelChip: "todo", listCard: "todo", menu: "todo",
  messageText: "todo", meter: "todo", nameMark: "todo", originTag: "todo", pill: "todo",
  previewDataNote: "todo", repoCounts: "todo", row: "todo", runStateBadge: "todo", seriesDot: "todo",
  sha: "todo", sizeWithTokens: "todo", stat: "todo", stateBadge: "todo", terminalCommand: "todo",
  terminalLine: "todo", time: "todo", tlComment: "todo", tlEvent: "todo", userLink: "todo",
  userTag: "todo", verdictBadge: "todo",
};

const components = Object.entries(ui).filter(([, v]) => typeof v === "function").map(([k]) => k);

test("every exported component has a spec or a named exclusion", () => {
  const missing = components.filter((n) => !(n in EXCLUDED) && !existsSync(`${import.meta.dir}/${n}.test.ts`));
  expect(missing).toEqual([]);
});

test("the exclusion list only shrinks: no stale or already-specced names", () => {
  const stale = Object.keys(EXCLUDED).filter((n) => !components.includes(n) || existsSync(`${import.meta.dir}/${n}.test.ts`));
  expect(stale).toEqual([]);
});
