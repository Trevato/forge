import { describe, expect, test } from "bun:test";
import { ERROR_LINE_MAX, firstErrorLine } from "../src/runs/error_line.ts";
import { oneLine } from "../src/checks/words.ts";
import { parseTestsRow } from "../src/checks/tests-row.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("the lines a red check is explained by are cut at a code point", () => {
  test("error_line cuts a 300-character line with an emoji straddling its limit and leaves no lone surrogate", () => {
    // The emoji's high surrogate sits at index ERROR_LINE_MAX - 2, so a
    // UTF-16 cut at ERROR_LINE_MAX - 1 would split it.
    const head = "error: " + "x".repeat(ERROR_LINE_MAX - 2 - 7);
    const line = head + "🔥" + "y".repeat(300 - head.length - 2);
    expect(line.length).toBe(300);
    const got = firstErrorLine([line])!;
    expect(got.at).toBe(1);
    expect(LONE_SURROGATE.test(got.text)).toBe(false);
    expect(got.text.endsWith("…")).toBe(true);
    expect(Array.from(got.text).length).toBe(ERROR_LINE_MAX);
  });

  test("a failure's one line keeps an emoji whole at its limit", () => {
    const text = "x".repeat(78) + "🔥" + "y".repeat(40);
    const got = oneLine(text);
    expect(LONE_SURROGATE.test(got)).toBe(false);
    expect(Array.from(got).length).toBe(80);
  });

  test("a pinned failing test named with an emoji reads whole", () => {
    const name = "z".repeat(198) + "🔥 tail";
    const row = parseTestsRow([`(fail) ${name}`]);
    expect(LONE_SURROGATE.test(row.failures[0]!.name)).toBe(false);
  });

  test("a summary cut through an emoji leaves no lone surrogate", () => {
    const line = "w".repeat(198) + "🔥" + "v".repeat(20);
    const got = summariseCheckFailure([line], "check exited with code 1");
    expect(LONE_SURROGATE.test(got.summary)).toBe(false);
    expect(Array.from(got.summary).length).toBe(200);
  });
});
