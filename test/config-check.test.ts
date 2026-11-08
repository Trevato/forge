import { expect, test } from "bun:test";
import { checkConfig, LOCATE_MAX_CHARS } from "../src/text/config_check.ts";

test("a small broken JSON file is located by line and column", () => {
  const r = checkConfig("json", '{\n  "a": 1,\n  "b": ]\n}');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.line).toBe(3);
});

test("a large broken file answers quickly", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `  "k${i}": ${i},`).join("\n");
  const multi = `{\n${lines}\n  "end": ]\n}`;
  const t = performance.now();
  const r = checkConfig("json", multi);
  expect(r.ok).toBe(false);
  const oneLine = `[${"1,".repeat(50_000)}]]`;
  expect(oneLine.length).toBeGreaterThan(LOCATE_MAX_CHARS);
  const r2 = checkConfig("json", oneLine);
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.line).toBeUndefined();
  expect(performance.now() - t).toBeLessThan(1000);
});

test("alias-heavy YAML does not stall", () => {
  let s = "a0: &a0 [x, x]\n";
  for (let i = 1; i < 20000; i++) s += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
  const t = performance.now();
  checkConfig("yaml", s);
  expect(performance.now() - t).toBeLessThan(1000);
});
