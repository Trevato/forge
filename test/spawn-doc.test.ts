import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_MS } from "../src/spawn/upstream.ts";
import { TAKE_BRANCH } from "../src/spawn/take.ts";
import { FOLLOW_MODES } from "../src/spawn/chain.ts";

const doc = readFileSync(join(import.meta.dir, "..", "docs/SPAWN.md"), "utf8");

test("the doc has the section on following the parent forge", () => {
  expect(doc).toContain("## Following the parent forge");
  expect(doc).not.toContain("not\nbehaviour");
});

test("the doc names the check interval, the take branch and both follow modes", () => {
  expect(CHECK_MS).toBeGreaterThan(0);
  expect(doc).toContain("`CHECK_MS`");
  expect(doc).toContain(`\`${TAKE_BRANCH}\``);
  for (const m of FOLLOW_MODES) expect(doc).toContain(`\`${m}\``);
  expect(doc).toContain("refs/upstream/*");
  expect(doc).toContain("upstream.json");
});
