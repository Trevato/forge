// A `*.test.ts` under `src/` is outside every gate plan, so the gate refuses it by name (#11222).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strayTestRefusal } from "../scripts/gate.ts";

function tree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-stray-test-"));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

test("a test under src/ is refused with its name; vendor and test/ are not", () => {
  const dir = tree([
    "src/apps/contain-label.test.ts",
    "src/a.test.ts",
    "src/apps/contain.ts",
    "src/vendor/lib/x.test.ts",
    "test/b.test.ts",
  ]);
  try {
    expect(strayTestRefusal(dir)).toEqual([
      "src/a.test.ts: a test outside test/ never runs in the gate; move it to test/",
      "src/apps/contain-label.test.ts: a test outside test/ never runs in the gate; move it to test/",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this repository has no test outside test/", () => {
  expect(strayTestRefusal(join(import.meta.dir, ".."))).toEqual([]);
});
