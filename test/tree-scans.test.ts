/**
 * A test that reads the tree is found by what it reads, not by a hand list
 * (#10304): a new scan runs in every pull's fast tier the day it is
 * written, so the pull that breaks it is red on its own check, not main.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gateFiles } from "../scripts/gate.ts";
import { parseTimes } from "../scripts/shards.ts";
import { importsReader, scansIn } from "../scripts/tier-input.ts";
import { declaresNoScan, declaresScan, SCAN_BUDGET_SECONDS, scanSeconds, treeScans, walksTree } from "../src/checks/scans.ts";
import { fastSet, RULE_TESTS } from "../src/checks/tiers.ts";

describe("what a scan reads", () => {
  test("a glob or git ls-files lists the tree", () => {
    expect(walksTree(`for (const f of new Glob("src/**/*.ts").scanSync(".")) {}`)).toBe(true);
    expect(walksTree(`Bun.spawnSync(["git", "ls-files"])`)).toBe(true);
  });

  test("a readdir lists the tree only when it is rooted at the repository", () => {
    expect(walksTree(`readdirSync(join(import.meta.dir, "..", "src"))`)).toBe(true);
    expect(walksTree(`readdirSync("test").filter(f => f.endsWith(".ts"))`)).toBe(true);
    expect(walksTree(`readdirSync(process.cwd())`)).toBe(true);
    expect(walksTree(`const d = mkdtempSync(join(tmpdir(), "x")); readdirSync(d)`)).toBe(false);
  });

  test("the root counts only when it is what the readdir is handed", () => {
    // The module's own place, used for a fixture, beside a readdir of a temp dir: no scan.
    const fixture = `const jpeg = readFileSync(\`\${import.meta.dir}/fixtures/a.jpg\`);\nconst dir = join(dataDir, "looks");\nreaddirSync(dir);`;
    expect(walksTree(fixture)).toBe(false);
    expect(walksTree(`const repo = join(import.meta.dir, "..");\nreaddirSync(join(data, ".taking"));`)).toBe(false);
    // Through a bound name: a scan.
    expect(walksTree(`const ROOT = join(import.meta.dir, "..");\nconst DIR = join(ROOT, "src");\nreaddirSync(DIR);`)).toBe(true);
    const walk = `const walk = (d: string): string[] => readdirSync(d).flatMap((n) => walk(join(d, n)));\nwalk(join(import.meta.dir, "..", "src"));`;
    // A walk's parameter and a parameter's default are not inferred: such a scan declares itself.
    expect(walksTree(walk)).toBe(false);
    expect(declaresScan(`// @tree-scan: walks src/.\n${walk}`)).toBe(true);
    expect(walksTree(`export function files(root = ".") { return readdirSync(\`\${root}/test\`); }`)).toBe(false);
  });

  test("a scan the reading cannot see declares itself; a false one says it is not", () => {
    expect(declaresScan(`/**\n * @tree-scan: reads README.md.\n */`)).toBe(true);
    expect(declaresScan(`// @tree-scan`)).toBe(true);
    expect(declaresScan(`const s = "@tree-scan";`)).toBe(false);
    expect(declaresScan(` * @not-a-tree-scan: its own temp dirs.`)).toBe(false);
    expect(declaresNoScan(` * @not-a-tree-scan: its own temp dirs.`)).toBe(true);
  });
});

describe("the tests that scan", () => {
  const files: Record<string, string> = {
    "test/new-scan.test.ts": `readdirSync(join(import.meta.dir, "../src"));`,
    "test/via.test.ts": `import { audit } from "../scripts/audit.ts";`,
    "scripts/audit.ts": `export const audit = () => [...new Glob("**/*.ts").scanSync(".")];`,
    "test/readme.test.ts": `// @tree-scan: reads README.md\nreadFileSync("README.md");`,
    "test/temp.test.ts": `// @not-a-tree-scan: lists its own temp dir\nreaddirSync(join(import.meta.dir, "tmp"));`,
    "test/plain.test.ts": `import { a } from "../src/a.ts";`,
  };
  const imports = (file: string): string[] =>
    file === "test/via.test.ts" ? ["scripts/audit.ts"] : file === "test/plain.test.ts" ? ["src/a.ts"] : [];
  const tests = Object.keys(files).filter((f) => f.startsWith("test/"));
  const scans = treeScans(tests, (f) => files[f], imports);

  test("are found by their own source, a script they import, or their declaration", () => {
    expect(Object.fromEntries(scans)).toEqual({
      "test/new-scan.test.ts": "lists the tree",
      "test/via.test.ts": "lists the tree through scripts/audit.ts",
      "test/readme.test.ts": "declares a tree scan",
    });
  });

  test("run in the fast tier of a diff no import or coverage ties to them", () => {
    const plan = fastSet({
      changed: ["src/brand-new.ts"],
      tests,
      imports,
      times: new Map(),
      impact: new Map([["test/plain.test.ts", ["src/a.ts"]]]),
      scans,
    });
    for (const scan of scans.keys()) expect(plan.files).toContain(scan);
    expect(plan.why.get("test/new-scan.test.ts")).toBe("tree scan: lists the tree");
    expect(plan.files).not.toContain("test/temp.test.ts");
  });

  test("do not run for a diff of only the check's own tables", () => {
    const plan = fastSet({
      changed: ["scripts/test-times.json"],
      tests,
      imports,
      times: new Map(),
      scans,
    });
    expect(plan.files).toEqual([]);
  });
});

describe("this repository's scans", () => {
  const gate = gateFiles();
  const scans = scansIn(gate, importsReader());

  test("include every repo-wide rule test, so the hand list is no longer what finds them", () => {
    for (const rule of RULE_TESTS) expect([rule, scans.has(rule)]).toEqual([rule, true]);
  });

  test("cost together no more than their share of the fast tier's budget", () => {
    const all = new Set([...scans.keys(), ...RULE_TESTS]);
    const times = parseTimes(readFileSync(new URL("../scripts/test-times.json", import.meta.url), "utf8"));
    expect(times.ok).toBe(true);
    expect(scanSeconds(all, times.ok ? times.value : new Map())).toBeLessThanOrEqual(SCAN_BUDGET_SECONDS);
  });
});
