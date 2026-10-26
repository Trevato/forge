import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runsRoot } from "../src/runs/log.ts";
import { pruneRunFiles } from "../src/runs/prune.ts";

test("old run files go, recent ones stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  mkdirSync(runsRoot(dir), { recursive: true });
  const old = join(runsRoot(dir), "a.log");
  const fresh = join(runsRoot(dir), "b.log");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const past = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(old, past, past);
  expect(pruneRunFiles(dir)).toBe(1);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test("no runs directory is nothing to prune", () => {
  expect(pruneRunFiles(mkdtempSync(join(tmpdir(), "prune-")))).toBe(0);
});
