/**
 * docs/THREATS.md names what enforces each protection: one `Enforced by:` line
 * per bullet, the last cell of each call row, a test file or a scripts/ gate
 * that exists, or `none yet`. The `none yet` count is printed so it is seen,
 * and only editing a row lowers it.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enforcement, parseThreats } from "../src/core/threats.ts";

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/THREATS.md"), "utf8");
const exists = (path: string): boolean => existsSync(join(root, path));

test("the doc covers each adversary, the internal calls and honeypots", () => {
  for (const h of [
    "## A snooper on the network",
    "## A stolen token",
    "## A compromised vendor",
    "## A hostile agent inside a run",
    "## An automated attacker at scale",
    "## Internal calls",
    "## Honeypots (later)",
  ])
    expect(doc).toContain(h);
  for (const call of ["runner → forge", "cell → proxy", "edge → pod", "child → parent"])
    expect(doc).toContain(call);
  expect(doc).toContain('`kind: "honeypot"`');
});

test("every row names an enforcer that exists, or says none yet; the gaps are counted", () => {
  const got = enforcement(doc, exists);
  expect(got.problems).toEqual([]);
  expect(got.cited.length).toBeGreaterThan(10);
  // Every row the resilience page lists was judged here, none skipped.
  expect(got.cited.length + got.noneYet).toBe(parseThreats(doc).length);
  console.log(`threats: ${got.noneYet} row${got.noneYet === 1 ? "" : "s"} enforced by none yet`);
});

const FIXTURE = (rows: string): string => `# Threats\n\n## An adversary\n\n${rows}\n`;
const always = (): boolean => true;

test("a bullet with no Enforced by: line fails, naming the bullet", () => {
  const got = enforcement(FIXTURE("- Tokens carry a scope.\n- Sessions are HttpOnly.\n  Enforced by: `test/a.test.ts`"), always);
  expect(got.problems).toEqual(['"Tokens carry a scope." has no Enforced by: line']);
});

test("a named path that does not exist fails", () => {
  const got = enforcement(FIXTURE("- A.\n  Enforced by: `test/gone.test.ts`"), () => false);
  expect(got.problems).toEqual(['"A." names test/gone.test.ts, which does not exist']);
});

test("an enforcer that is neither a test, a scripts/ gate nor none yet fails", () => {
  const got = enforcement(FIXTURE("- A.\n  Enforced by: review\n- B.\n  Enforced by: `src/a.ts`"), always);
  expect(got.problems.length).toBe(2);
});

test("the old Test: line fails", () => {
  const got = enforcement(FIXTURE("- A.\n  Test: `test/a.test.ts`"), always);
  expect(got.problems).toEqual(['"A." uses the old Test: line; say Enforced by:']);
});

test("a scripts/ gate counts as an enforcer; none yet, with or without its issue, is counted", () => {
  const got = enforcement(
    FIXTURE(
      "- A.\n  Enforced by: `scripts/gate.ts`\n- B.\n  Enforced by: none yet\n- C.\n  Enforced by: none yet (#12)\n\n" +
        "| Call | How | Enforced by |\n| --- | --- | --- |\n| a → b | c | none yet |\n| b → c | d | `test/x.test.ts` |",
    ),
    always,
  );
  expect(got).toEqual({ problems: [], noneYet: 3, cited: ["scripts/gate.ts", "test/x.test.ts"] });
});

test("a call row whose last cell names no enforcer fails", () => {
  const got = enforcement(FIXTURE("| Call | How | Enforced by |\n| --- | --- | --- |\n| a → b | c | |"), always);
  expect(got.problems.length).toBe(1);
});

test("bullets under a (later) heading are preconditions, not rows", () => {
  const got = enforcement("# T\n\n## Honeypots (later)\n\n- its egress must be none;\n", always);
  expect(got).toEqual({ problems: [], noneYet: 0, cited: [] });
});
