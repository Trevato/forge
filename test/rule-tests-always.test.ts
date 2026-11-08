/**
 * The repo-wide rule tests run in every pull's fast tier (#7138): a pull
 * that only adds a test file holding a raw ms budget is red on its own
 * check, and the check's summary names the rule and the line.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFiles } from "../scripts/gate.ts";
import { rawBudgets } from "../scripts/flake.ts";
import { fastSet, RULE_TESTS } from "../src/checks/tiers.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";

const breaker = [
  'import { expect, test } from "bun:test";',
  'test("x", () => {',
  "  const t0 = performance.now();",
  // Split here so the rule, reading this file, does not find it.
  "  expect(performance.now() - t0)" +
    ".toBeLessThan(5);",
  "});",
].join("\n");

const scratch = mkdtempSync(join(tmpdir(), "forge-rule-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the repo-wide rule tests in the fast tier", () => {
  const gate = gateFiles();
  // A measured map that knows every test but the new one, as on a pull.
  const impact = new Map(gate.map((t) => [t, ["src/elsewhere.ts"]] as const));
  const plan = (changed: string[]) =>
    fastSet({
      changed,
      tests: [...gate, "test/x.test.ts"],
      imports: () => [],
      times: new Map(),
      impact,
    });

  test("every rule test is a gate file, so none is listed and never run", () => {
    for (const rule of RULE_TESTS) expect(gate).toContain(rule);
  });

  test("a pull adding only test/x.test.ts runs every rule test", () => {
    const fast = plan(["test/x.test.ts"]);
    for (const rule of RULE_TESTS) {
      expect(fast.files).toContain(rule);
      expect(fast.why.get(rule)).toBe("repo-wide rule");
    }
    expect(fast.files).toContain("test/x.test.ts");
  });

  test("a doc-only pull runs them too: the README budget is one", () => {
    expect(plan(["README.md"]).files).toEqual(expect.arrayContaining([...RULE_TESTS]));
  });

  test("a diff of only the check's own tables runs none: it can break no rule (#3579)", () => {
    expect(plan(["scripts/test-times.json"]).files).toEqual([]);
  });

  test("its raw ms budget is a red check whose summary names #4429 and the line", async () => {
    const found = rawBudgets("test/x.test.ts", breaker);
    expect(found).toHaveLength(1);
    // The rule as test/flake.test.ts states it, run by a real bun test.
    const file = join(scratch, "rule.test.ts");
    writeFileSync(
      file,
      [
        'import { describe } from "bun:test";',
        `import { breaches } from ${JSON.stringify(join(import.meta.dir, "helpers/rule.ts"))};`,
        'describe("no raw wall-clock budget in a test (#4429)", () => {',
        `  breaches("no test file holds a speed to a raw ms number", ${JSON.stringify(found)});`,
        "});",
      ].join("\n"),
    );
    const run = Bun.spawn([process.execPath, "test", file], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code).not.toBe(0);
    const { summary } = summariseCheckFailure(`${out}\n${err}`.split("\n"), "check exited with code 1");
    expect(summary).toContain("#4429");
    expect(summary).toContain("test/x.test.ts:4:");
  }, 30_000);
});
