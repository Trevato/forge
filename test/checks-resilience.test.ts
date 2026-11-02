/**
 * readResilience, the rows the Resilience page and the terminal draw: every
 * protection in docs/THREATS.md once, in the document's order, with its
 * standing from the last full gate — unknown said ("untested", "no test yet"),
 * never dropped.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepGate } from "../src/checks/gate_last.ts";
import { readResilience, type Row } from "../src/checks/resilience.ts";

const DOC = readFileSync(join(import.meta.dir, "..", "docs", "THREATS.md"), "utf8");
const UNKNOWN = new Set(["untested", "no test yet"]);

// Counted from the document without its parser: one protection per `Test:`
// line, one per table row naming a call.
const TESTS = DOC.split("\n").filter((l) => /^\s*Test: /.test(l)).length;
const CALLS = DOC.split("\n").filter((l) => l.startsWith("| ") && l.includes("→")).length;

let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-checks-resilience-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Each row's text starts somewhere in the document, after the row before it. */
function inDocOrder(rows: readonly Row[]): void {
  const flat = DOC.replace(/\s+/g, " ");
  let at = 0;
  for (const { p } of rows) {
    const found = flat.indexOf(p.text.slice(0, 40), at);
    expect(found, p.text).toBeGreaterThanOrEqual(at);
    at = found + 1;
  }
}

function once(rows: readonly Row[]): void {
  const keys = rows.map(({ p }) => `${p.adversary}\n${p.text}`);
  expect(new Set(keys).size).toBe(keys.length);
}

test("with no gate yet, every protection is listed once, in order, with an unknown standing", () => {
  const rows = readResilience(dataDir);
  expect(TESTS + CALLS).toBeGreaterThan(0);
  expect(rows.length).toBe(TESTS + CALLS);
  once(rows);
  inDocOrder(rows);
  for (const r of rows) {
    expect(UNKNOWN.has(r.s), r.p.text).toBe(true);
    expect(r.s).toBe(r.p.test === undefined ? "no test yet" : "untested");
  }
});

test("after a full gate with one protection green and one red, those read so and the rest stay unknown", () => {
  const before = readResilience(dataDir);
  const cited = [...new Set(before.flatMap(({ p }) => (p.test ? [p.test] : [])))];
  const [green, red] = cited;
  if (green === undefined || red === undefined) throw new Error("THREATS.md cites fewer than two tests");
  keepGate(dataDir, [
    `${green}:`,
    "(pass) holds",
    `${red}:`,
    "(pass) one holds",
    "(fail) one does not",
  ]);

  const rows = readResilience(dataDir);
  expect(rows.length).toBe(before.length);
  once(rows);
  inDocOrder(rows);
  expect(rows.map(({ p }) => p)).toEqual(before.map(({ p }) => p));
  for (const r of rows) {
    if (r.p.test === green) expect(r.s).toBe("green");
    else if (r.p.test === red) expect(r.s).toBe("red");
    else expect(UNKNOWN.has(r.s), r.p.text).toBe(true);
  }
  expect(rows.some((r) => r.s === "green")).toBe(true);
  expect(rows.some((r) => r.s === "red")).toBe(true);
  expect(rows.filter((r) => r.p.test === undefined).every((r) => r.s === "no test yet")).toBe(true);
});
