import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/THREATS.md"), "utf8");

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

test("every test file the doc cites exists", () => {
  const cited = new Set(
    [...doc.matchAll(/`(test\/[A-Za-z0-9_.-]+\.test\.ts)`/g)].map((m) => m[1]!),
  );
  expect(cited.size).toBeGreaterThan(10);
  for (const file of cited) expect(existsSync(join(root, file))).toBe(true);
});

test("every protection ends in a test file or 'none yet', and the gaps are counted", () => {
  const lines = doc.split("\n");
  const tests = lines.filter((l) => /^\s+Test: /.test(l));
  // Each bullet outside the honeypot list has exactly one Test: line.
  const honeypots = doc.indexOf("## Honeypots");
  const bullets = lines.filter((l) => l.startsWith("- ")).length;
  const inHoneypots = doc.slice(honeypots).split("\n").filter((l) => l.startsWith("- ")).length;
  expect(tests.length).toBe(bullets - inHoneypots);
  let gaps = 0;
  for (const l of tests) {
    const what = l.replace(/^\s+Test: /, "");
    if (what === "none yet") gaps++;
    else expect(what).toMatch(/^`test\/[^`]+\.test\.ts`$/);
  }
  // Table rows name their test in the last cell.
  for (const l of lines.filter((l) => l.startsWith("| ") && l.includes("→"))) {
    const cell = l.split("|").at(-2)!.trim();
    if (cell === "none yet") gaps++;
    else expect(cell).toMatch(/^`test\/[^`]+\.test\.ts`$/);
  }
  expect(gaps).toBeGreaterThan(0);
  console.log(`threats: ${gaps} protection${gaps === 1 ? "" : "s"} with no test yet`);
});
