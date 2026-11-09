/** Retired 2026-11-09 with the pipeline-first direction: the gate no longer asks (`scripts/gate.ts`); the pure rule keeps its tests until the module goes. */
import { expect, test } from "bun:test";
import { featuresAdded, whyNowProblems } from "../src/kernel/why_now.ts";

const add = (path: string) => ({ status: "A", path });

test("a new action, page or route is a feature; edits, tests and other files are not", () => {
  expect(featuresAdded([add("src/actions/x.ts"), add("src/web/pages/y.ts"), add("src/http/api/z.ts")])).toHaveLength(3);
  expect(featuresAdded([add("src/http/mcp/tools/x.ts"), add("src/tui/app/screen.ts"), add("src/http/api/v1/y.ts")])).toHaveLength(3);
  expect(featuresAdded([{ status: "M", path: "src/actions/x.ts" }, add("test/x.test.ts"), add("src/core/x.ts")])).toEqual([]);
});

test("a feature with no answer to the direction is refused, naming the rule and the file", () => {
  const [p] = whyNowProblems([add("src/actions/x.ts")], ["Add x\n\nIt does x."]);
  expect(p).toContain("say why it goes ahead of the pipeline");
  expect(p).toContain("src/actions/x.ts");
});

test("a Why now line or a Pipeline line answers it; a thin reason does not", () => {
  const changes = [add("src/actions/x.ts")];
  expect(whyNowProblems(changes, ["Add x\n\nWhy now: the owner asked for it in #1234 this week"])).toEqual([]);
  expect(whyNowProblems(changes, ["Add x\n\nPipeline: #6534"])).toEqual([]);
  expect(whyNowProblems(changes, ["Add x\n\nWhy now: soon"])).toHaveLength(1);
});

test("a pull that adds no feature is never asked", () => {
  expect(whyNowProblems([add("test/a.test.ts")], ["Fix a"])).toEqual([]);
});
