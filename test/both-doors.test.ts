import { expect, test } from "bun:test";
import { bothDoorsProblems } from "../src/kernel/both_doors.ts";

const ch = (status: string, path: string) => ({ status, path });
const page = ch("A", "src/web/pages/traffic.ts");

const TUI = "terminal screen in src/tui/ (entry where AGENTS.md says)";
const DOCS = "docs/features/<name>.md how-to";
const tail = '; add them, or put a "No door: <why>" line (10+ characters) in a commit message';

test("a new page with neither door is refused, naming the rule and both missing doors", () => {
  expect(bothDoorsProblems([page], ["Add traffic"])).toEqual([
    `rule "both doors": this pull adds src/web/pages/traffic.ts but no ${TUI} and no ${DOCS}${tail}`,
  ]);
});

test("one door is not enough: the other is named alone", () => {
  expect(bothDoorsProblems([page, ch("A", "src/tui/screens/traffic.ts")], [])).toEqual([
    `rule "both doors": this pull adds src/web/pages/traffic.ts but no ${DOCS}${tail}`,
  ]);
  expect(bothDoorsProblems([page, ch("A", "docs/features/traffic.md")], [])).toEqual([
    `rule "both doors": this pull adds src/web/pages/traffic.ts but no ${TUI}${tail}`,
  ]);
});

test("both doors pass; so does a No door line; edits and other files are never asked", () => {
  expect(bothDoorsProblems([page, ch("A", "src/tui/screens/t.ts"), ch("A", "docs/features/t.md")], [])).toEqual([]);
  expect(bothDoorsProblems([page], ["x\n\nNo door: a public landing page, nothing to administer"])).toEqual([]);
  expect(bothDoorsProblems([page], ["No door: no"])).toHaveLength(1);
  expect(bothDoorsProblems([ch("M", "src/web/pages/traffic.ts"), ch("A", "src/core/x.ts")], [])).toEqual([]);
});
