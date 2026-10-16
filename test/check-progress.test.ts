import { expect, test } from "bun:test";
import { parseShardProgress, progressWords } from "../src/checks/progress.ts";
import { checksLine } from "../src/web/pages/pull.ts";
import type { Run } from "../src/core/runs.ts";

const live = [
  "test-shards: 170 files in 4 shards, expected 90s 91s 90s 92s",
  "",
  "── shard 1/4: a.test.ts b.test.ts",
  " 500 pass",
  " 0 fail",
  "── shard 1/4 done (exit 0, 3.0s)",
  "── shard 2/4: c.test.ts",
  " 312 pass",
  " 0 fail",
];

test("counts come from the runner's own lines, and only those", () => {
  expect(parseShardProgress(live)).toEqual({ of: 170, files: 2, passed: 812, failed: 0 });
  expect(progressWords(parseShardProgress(live))).toBe("2 of 170 files · 812 passed, 0 failed");
  const batched = [
    "test-shards: 3 files in 2 shards",
    "── shard 1/2 (exit 0, 2.0s): a.ts b.ts",
    " 7 pass",
    " 1 fail",
  ];
  expect(progressWords(parseShardProgress(batched))).toBe("2 of 3 files · 7 passed, 1 failed");
  // a stray "5 pass" before any shard report, or a build log, is not a count
  expect(progressWords(parseShardProgress([" 5 pass", " 0 fail", "tsc ok"]))).toBe("");
  expect(progressWords(parseShardProgress(["test-shards: 9 files in 1 shard"]))).toBe("");
});

const run = {
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
} as Run;
const fragmentOf = (progress: string) =>
  checksLine("/a/b", { state: "running", run }, false, true, false, "", "", 0, "", false, progress, "/a/b/pulls/7/checks-line").text;

test("the live fragment changes when the run's counts change", () => {
  const before = fragmentOf("");
  const after = fragmentOf(progressWords(parseShardProgress(live)));
  expect(before).toContain('data-live-src="/a/b/pulls/7/checks-line"');
  expect(before).toContain('id="live-checks"');
  expect(before).not.toContain("files");
  expect(after).toContain("2 of 170 files · 812 passed, 0 failed");
  expect(after).not.toBe(before);
});

test("the terminal's line carries the same counts", async () => {
  const { checksText } = await import("../src/tui/screens/pull.ts");
  const words = progressWords(parseShardProgress(live));
  const check = { state: "running", run } as const;
  const withCounts = checksText(check, false, true, "", false, words);
  expect(withCounts).toContain("2 of 170 files · 812 passed, 0 failed");
  expect(withCounts).toMatch(/^Check running · /);
  expect(checksText(check, false, true)).not.toContain(" files");
});
