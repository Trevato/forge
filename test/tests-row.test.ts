import { expect, test } from "bun:test";
import { parseTestsRow, testsRowWords } from "../src/checks/tests-row.ts";

const log = [
  "test-shards: 9 files in 3 shards",
  "",
  "── shard 1/3: test/a.test.ts test/b.test.ts",
  "test/a.test.ts:",
  "(pass) a works",
  "error: expect(received).toBe(expected)",
  "Expected: 1",
  "Received: 2",
  "      at <anonymous> (test/b.test.ts:4:5)",
  "(fail) b breaks",
  " 5 pass",
  " 1 fail",
  "── shard 1/3 done (exit 1, 2.0s)",
  "(fail) b breaks [shard 1]",
  "── shard 2/3: test/c.test.ts test/d.test.ts test/e.test.ts",
];

test("two finished files and one failure give the counts and one pinned failure", () => {
  const row = parseTestsRow(log.slice(0, 13));
  expect(testsRowWords(row)).toBe("2 of 9 files started · 5 passed, 1 failed");
  expect(row.failures).toEqual([
    {
      name: "b breaks",
      lines: ["error: expect(received).toBe(expected)", "Expected: 1", "Received: 2"],
    },
  ]);
  expect(row.running).toBeUndefined();
});

test("the shard running now is named, an echoed failure is not pinned twice", () => {
  const row = parseTestsRow(log);
  expect(row.started).toBe(5);
  expect(row.running).toEqual(["test/c.test.ts", "test/d.test.ts", "test/e.test.ts"]);
  expect(row.failures.length).toBe(1);
});

test("a log without the runner's lines gives nothing", () => {
  const row = parseTestsRow(["tsc ok"]);
  expect(testsRowWords(row)).toBe("");
  expect(row.failures).toEqual([]);
});
