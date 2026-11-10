import { expect, test } from "bun:test";
import { directionProblems } from "../src/kernel/direction.ts";

const ch = (status: string, path: string) => ({ status, path });
const page = ch("A", "src/web/pages/machines.ts");

test("a new feature with no pipeline change is refused, naming the rule", () => {
  const out = directionProblems([page], ["Add machines"]);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('rule "pipeline first"');
  expect(out[0]).toContain("src/web/pages/machines.ts");
  expect(out[0]).toContain('"Direction: <why');
});

test("a pipeline change, or a Direction line of 10+ characters, passes", () => {
  expect(directionProblems([page, ch("M", "scripts/gate.ts")], [])).toEqual([]);
  expect(directionProblems([page], ["x\n\nDirection: a small door onto the spawn path, owner asked on #7642"])).toEqual([]);
  expect(directionProblems([page], ["Direction: no"])).toHaveLength(1);
});

test("edits and non-feature files are never asked", () => {
  expect(directionProblems([ch("M", "src/web/pages/machines.ts"), ch("A", "src/core/x.ts")], [])).toEqual([]);
  expect(directionProblems([ch("A", "docs/features/x.md")], [])).toHaveLength(1);
});

test("the reason must sit on the Direction line itself, not a later paragraph", () => {
  expect(directionProblems([page], ["Direction:\n\nsome later paragraph of text"])).toHaveLength(1);
});
