import { expect, test } from "bun:test";
import { checkWords } from "../src/checks/summary.ts";
import { runTitle } from "../src/web/pages/runs.ts";
import { checksLine } from "../src/web/pages/pull.ts";
import type { Run } from "../src/core/runs.ts";

const T0 = Date.parse("2026-10-16T10:00:00Z");
const run = (over: Partial<Run> = {}): Run =>
  ({
    id: "r1",
    kind: "check",
    env: "pull-7",
    commitOid: "abcdef1234567",
    state: "running",
    summary: "",
    createdAt: "2026-10-16T10:00:00Z",
    startedAt: "2026-10-16T10:00:00Z",
    finishedAt: null,
    checkDetail: null,
    baseOid: "",
    ...over,
  }) as Run;
const line = (r: Run) =>
  checksLine("/a/b", { state: r.state, run: r }, false, true).text;

test("a running check is named with its age and links to its run", () => {
  expect(checkWords(run(), T0 + 12 * 60_000)).toBe("Check running · 12 min");
  const text = line(run());
  expect(text).toContain("Check running · ");
  expect(text).toContain('href="/a/b/runs/r1"');
  expect(text).toContain("Check of");
  expect(text.toLowerCase()).not.toContain("deploy");
});

test("a finished check says how long it took or what failed first", () => {
  const done = run({ state: "ok", finishedAt: "2026-10-16T10:03:00Z" });
  expect(checkWords(done)).toBe("Check passed in 3 min");
  expect(line(done)).toContain("Check passed in 3 min");
  const bad = run({
    state: "failed",
    summary: "1 of 9 tests",
    checkDetail: { passed: 8, failed: 1, names: ["it adds"] } as Run["checkDetail"],
  });
  expect(checkWords(bad)).toBe("Check failed: it adds");
  expect(line(bad)).toContain("Check failed: it adds");
  expect(line(bad).toLowerCase()).not.toContain("deploy");
});

test("a check's run page is titled by its commit and pull", () => {
  expect(runTitle(run(), undefined, undefined)).toBe("Check of abcdef1 for #7");
  expect(runTitle(run({ env: "" }), undefined, undefined)).toBe("Check of abcdef1");
});
