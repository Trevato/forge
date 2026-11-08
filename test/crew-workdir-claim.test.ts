import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimWorkdir } from "../src/crew/workdir.ts";

const base = () => join(mkdtempSync(join(tmpdir(), "claim-")), "7651");

test("a run takes the issue's clone when nobody holds it", async () => {
  const b = base();
  const a = claimWorkdir(b, "run1");
  expect(a.dir).toBe(b);
  expect(a.own).toBe(false);
  await a.release();
  expect(claimWorkdir(b, "run2").dir).toBe(b);
});

test("a concurrent run on the same issue gets a directory of its own, removed when it ends (#8219)", async () => {
  const b = base();
  const first = claimWorkdir(b, "run1");
  const second = claimWorkdir(b, "run2");
  expect(second.dir).not.toBe(first.dir);
  expect(second.own).toBe(true);
  const third = claimWorkdir(b, "run3");
  expect(third.dir).not.toBe(second.dir);
  mkdirSync(second.dir, { recursive: true });
  await second.release();
  expect(existsSync(second.dir)).toBe(false);
  await third.release();
  await first.release();
  expect(claimWorkdir(b, "run4").dir).toBe(b);
});
