import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A flow read takes `now`; reading the wall clock inside the body makes it flaky by the hour.
const dir = join(import.meta.dir, "..", "src", "flow");
const clock = /Date\.now\(\)|new Date\(\)/g;
// `now = new Date()` / `now: Date | number = Date.now()` as a parameter default.
const paramDefault = /(?:^\s*|[(,]\s*)\w+\s*(?::[^=()]+)?=\s*$/;

export function wallClockReads(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(clock)) {
      if (paramDefault.test(code.slice(0, m.index))) continue;
      hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

test("no src/flow file reads the wall clock outside a default parameter", () => {
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => wallClockReads(`src/flow/${f}`, readFileSync(join(dir, f), "utf8")));
  expect(hits).toEqual([]);
});

test("the scan catches a body read and allows a default", () => {
  expect(wallClockReads("x.ts", "const t = Date.now();")).toHaveLength(1);
  expect(wallClockReads("x.ts", "  return new Date().getTime();")).toHaveLength(1);
  expect(wallClockReads("x.ts", "const d = x ?? new Date();")).toHaveLength(1);
  expect(wallClockReads("x.ts", "export function f(db: D, now = new Date(), p = false) {")).toEqual([]);
  expect(wallClockReads("x.ts", "export async function f(a: A, now: Date | number = Date.now()) {")).toEqual([]);
  expect(wallClockReads("x.ts", "  now = Date.now(),")).toEqual([]);
});
