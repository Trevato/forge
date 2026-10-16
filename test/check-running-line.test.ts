import { expect, test } from "bun:test";
import type { Run } from "../src/core/runs.ts";
import { checksLine } from "../src/web/pages/pull.ts";
import { checksRefusal, checksText } from "../src/tui/screens/pull.ts";
import { runTitle } from "../src/tui/screens/runlist.ts";

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const run = (over: Partial<Run>): Run =>
  ({
    id: "r1",
    kind: "check",
    state: "running",
    commitOid: "abcdef0123456789",
    env: "pull-7",
    summary: "",
    baseOid: "",
    createdAt: at(13 * 60_000),
    startedAt: at(12 * 60_000),
    finishedAt: null,
    checkDetail: null,
    ...over,
  }) as Run;
const line = (r: Run) =>
  checksLine("/a/b", { state: r.state, run: r }, false, true).text;
const term = (r: Run) => checksText({ state: r.state, run: r }, false, true);

test("a long failure is cut to one line on the page and in the terminal", () => {
  const bad = run({ state: "failed", summary: "x".repeat(300) });
  expect(line(bad)).toContain(`${"x".repeat(79)}…`);
  expect(line(bad)).not.toContain("x".repeat(80));
  expect(term(bad)).toContain(`${"x".repeat(79)}…`);
  expect(checksRefusal({ state: "failed", run: bad })).not.toContain("x".repeat(80));
});

test("a queued check is singular like the other states", () => {
  expect(line(run({ state: "queued" }))).toMatch(/Check\s+queued/);
});

test("the terminal says the same words as the page and names the run", () => {
  expect(term(run({}))).toBe("Check running · 12 min · run r1");
  const done = run({ state: "ok", finishedAt: at(0), startedAt: at(41 * 60_000) });
  expect(term(done)).toBe("Check passed in 41 min · run r1");
  const bad = run({ state: "failed", summary: "boom" });
  expect(term(bad)).toBe("Check failed: boom · run r1");
  expect(checksRefusal({ state: "failed", run: bad })).toBe("the check of this head failed: boom");
  expect(term(run({ state: "queued" }))).toContain("a check of this head is queued");
});

test("the terminal's run list titles a check run", () => {
  expect(runTitle(run({}), new Map())).toBe("Check of abcdef0 for #7");
});
