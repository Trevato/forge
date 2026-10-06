/**
 * Every test file is accounted for (`scripts/gate.ts`): in the gate, or
 * excluded by name with a reason and the issue that owns admitting it. A
 * new test file that is in neither list turns the check red, so it cannot
 * sit outside the gate silently.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { auditGate, EXCLUDED, GATE } from "../scripts/gate.ts";

const root = new URL("..", import.meta.url).pathname;
const present = readdirSync(`${root}test`)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`)
  .sort();

describe("the gate's list", () => {
  test("every test/*.test.ts is in exactly one list, and every entry exists", () => {
    expect(auditGate(present, GATE, EXCLUDED)).toEqual([]);
  });

  test("this guard is itself in the gate", () => {
    expect(GATE).toContain("test/check-list.test.ts");
  });

  test("forge.json's check names no test file and runs the gate's list", async () => {
    const manifest = (await Bun.file(`${root}forge.json`).json()) as {
      check: { run: string };
    };
    expect(manifest.check.run).not.toMatch(/\.test\.[cm]?[jt]sx?\b/);
    expect(manifest.check.run).toContain("scripts/test-shards.ts");
    expect(manifest.check.run).toContain("--gate");
  });
});

describe("auditGate", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];

  test("a file in neither list is named", () => {
    expect(auditGate(files, ["test/a.test.ts"], [])).toEqual([
      "test/b.test.ts is in neither GATE nor EXCLUDED",
    ]);
  });

  test("a file in both lists is named", () => {
    expect(
      auditGate(files, files, [
        { file: "test/b.test.ts", reason: "slow", issue: 1 },
      ]),
    ).toEqual(["test/b.test.ts is in both GATE and EXCLUDED"]);
  });

  test("an exclusion with no reason or no issue is named", () => {
    expect(
      auditGate(
        files,
        [],
        [
          { file: "test/a.test.ts", reason: " ", issue: 7 },
          { file: "test/b.test.ts", reason: "slow", issue: 0 },
        ],
      ),
    ).toEqual([
      "test/a.test.ts is excluded with no reason",
      "test/b.test.ts is excluded with no issue number",
    ]);
  });

  test("an entry naming a file that does not exist is named", () => {
    expect(
      auditGate(
        files,
        [...files, "test/gone.test.ts"],
        [{ file: "test/old.test.ts", reason: "slow", issue: 3 }],
      ),
    ).toEqual([
      "test/gone.test.ts is in GATE but does not exist",
      "test/old.test.ts is in EXCLUDED but does not exist",
    ]);
  });

  test("a file named twice in one list is named", () => {
    expect(auditGate(files, [...files, "test/a.test.ts"], [])).toEqual([
      "test/a.test.ts is in GATE twice",
    ]);
  });
});
