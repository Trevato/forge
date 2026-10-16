import { expect, test } from "bun:test";
import { junitFiles, missed, redFiles, runsAll, verdict } from "../src/checks/changed_compare.ts";

test("a failed test belongs to the file header printed before it", () => {
  const log = [
    "test/a.test.ts:",
    "(pass) one",
    "(fail) two [1ms]",
    "test/b.test.ts:",
    "(pass) three",
    "(fail) four",
    "(fail) five",
    "(fail) with no header above is not a file",
  ].join("\n");
  expect(redFiles(log)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  expect(redFiles("(fail) orphan\nnothing")).toEqual([]);
});

test("a bun report names the files it opened, and only test files", () => {
  const xml = `<testsuite name="test/b.test.ts" x="1"><testsuite name="a describe"/><testsuite name="test/a.test.ts"/><testsuite name="../etc/x.test.ts"/>`;
  expect(junitFiles(xml)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
});

test("what no import can show runs everything", () => {
  for (const f of ["forge.json", "bun.lock", "package.json", "test/fixtures/a.json", "scripts/gate.ts", "src/web/style.css"])
    expect(runsAll(f)).toBe(true);
  for (const f of ["src/a.ts", "test/a.test.ts", "README.md", "docs/X.md", "scripts/test-times.json"])
    expect(runsAll(f)).toBe(false);
});

test("a pick misses the reds it left out", () => {
  expect(missed(["a", "b"], new Set(["a"]))).toEqual(["b"]);
});

test("the verdict keeps a pick that missed nothing, the smaller of two such", () => {
  const row = (fast: string[] | undefined, bun: string[], reds: string[]) => ({
    pull: 1,
    changed: 1,
    ...(fast === undefined ? {} : { fast }),
    bun,
    reds,
  });
  expect(verdict([row(["a", "b"], ["a"], [])]).use).toBe("bun");
  expect(verdict([row(["a"], ["a", "b"], [])]).use).toBe("fast");
  expect(verdict([row(["a", "b"], ["a"], ["b"])]).use).toBe("fast");
  expect(verdict([row(["a"], ["a", "b"], ["b"])]).use).toBe("bun");
  expect(verdict([row(["a"], ["b"], ["a", "b"])]).use).toBe("neither");
  expect(verdict([row(undefined, ["a"], ["b"])]).compared).toBe(0);
});
