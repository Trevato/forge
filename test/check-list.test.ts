/**
 * The gate is every test file minus a short quarantine (`scripts/gate.ts`,
 * #2037): a new test file is gated by existing, with no list to edit, and
 * every exclusion names a file that exists, a reason, and the issue that
 * owns admitting it.
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditGate, EXCLUDED, gateFiles, gateRefusal, treeGate } from "../scripts/gate.ts";

const root = new URL("..", import.meta.url).pathname;
const present = readdirSync(`${root}test`)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`)
  .sort();

describe("the gate's list", () => {
  test("every exclusion is sound against the files that exist", () => {
    expect(auditGate(present, EXCLUDED)).toEqual([]);
    expect(gateRefusal(present)).toEqual([]);
  });

  test("the gate is every present test file not excluded", () => {
    const out = new Set(EXCLUDED.map((e) => e.file));
    expect(gateFiles()).toEqual(present.filter((f) => !out.has(f)));
    expect(gateFiles().length + EXCLUDED.length).toBe(present.length);
  });

  test("this guard is itself in the gate: no exclusion names it", () => {
    expect(EXCLUDED.map((e) => e.file)).not.toContain("test/check-list.test.ts");
  });

  test("forge.json's check names no test file and runs the gate's list", async () => {
    const manifest = (await Bun.file(`${root}forge.json`).json()) as {
      check: { run: string; fast: string };
    };
    expect(manifest.check.run).not.toMatch(/\.test\.[cm]?[jt]sx?\b/);
    // A pull's check runs the tests; landing re-proves lint and types on the merged tree (#7703).
    expect(manifest.check.fast).toContain("scripts/test-shards.ts");
    expect(manifest.check.fast).toContain("--tier fast");
  });
});

describe("gateFiles", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];

  test("a new file is in the gate with no list naming it", () => {
    expect(gateFiles([...files, "test/x.test.ts"], [])).toEqual([
      ...files,
      "test/x.test.ts",
    ]);
  });

  test("an excluded file is not", () => {
    expect(
      gateFiles(files, [{ file: "test/b.test.ts", reason: "slow", issue: 1 }]),
    ).toEqual(["test/a.test.ts", "test/c.test.ts"]);
  });
});

describe("auditGate", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];

  test("a file in no list is no problem", () => {
    expect(auditGate(files, [])).toEqual([]);
  });

  test("an exclusion with no reason or no issue is named", () => {
    expect(
      auditGate(files, [
        { file: "test/a.test.ts", reason: " ", issue: 7 },
        { file: "test/b.test.ts", reason: "slow", issue: 0 },
      ]),
    ).toEqual([
      "test/a.test.ts is excluded with no reason",
      "test/b.test.ts is excluded with no issue number",
    ]);
  });

  test("an exclusion naming a file that does not exist is named", () => {
    expect(
      auditGate(files, [{ file: "test/old.test.ts", reason: "slow", issue: 3 }]),
    ).toEqual(["test/old.test.ts is in EXCLUDED but does not exist"]);
  });

  test("a file excluded twice is named", () => {
    const entry = { file: "test/a.test.ts", reason: "slow", issue: 3 };
    expect(auditGate(files, [entry, entry])).toEqual([
      "test/a.test.ts is in EXCLUDED twice",
    ]);
  });
});

describe("treeGate: the gate an older commit's tree names", () => {
  const tree = (gate: string, tests: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "forge-tree-gate-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "scripts/gate.ts"), gate);
    for (const file of tests) writeFileSync(join(dir, file), "");
    return dir;
  };

  test("a tree from before #2071 is read from its GATE list", async () => {
    const dir = tree(
      'export const GATE = ["test/a.test.ts"];\nexport const EXCLUDED = [];\n',
      ["test/a.test.ts", "test/b.test.ts"],
    );
    try {
      expect(await treeGate(dir, "old")).toEqual(["test/a.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a later tree derives it from its own test files minus EXCLUDED", async () => {
    const dir = tree("", ["test/a.test.ts", "test/zz-new.test.ts", EXCLUDED[0]!.file]);
    copyFileSync(`${root}scripts/gate.ts`, join(dir, "scripts/gate.ts"));
    try {
      expect(await treeGate(dir, "new")).toEqual(["test/a.test.ts", "test/zz-new.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
