import { expect, test } from "bun:test";
import { plural } from "../src/kernel/plural.ts";
import { bytes, span, spark } from "../src/system/format.ts";

test("bytes at its edges", () => {
  expect(bytes(0)).toBe("0 B");
  expect(bytes(1023)).toBe("1023 B");
  expect(bytes(1024)).toBe("1.0 KiB");
  expect(bytes(10 * 1024)).toBe("10 KiB");
  expect(bytes(1.5 * 1024 ** 3)).toBe("1.5 GiB");
});

test("span at its edges", () => {
  expect(span(89)).toBe("89s");
  expect(span(120)).toBe("2m");
  expect(span(5399)).toBe("90m");
  expect(span(172_800)).toBe("2d");
});

test("spark draws one block per reading, clamped, and never drops a bad one", () => {
  expect(spark([0, 50, 100])).toBe("▁▅█");
  expect(spark([-5, 150])).toBe("▁█");
  const s = spark([20, NaN, Infinity, -Infinity, 100]);
  expect([...s].length).toBe(5);
  expect(s).toBe("▂▁▁▁█");
  expect(spark([])).toBe("");
});

test("plural", () => {
  expect(plural(1, "comment")).toBe("1 comment");
  expect(plural(0, "comment")).toBe("0 comments");
  expect(plural(2, "person", "people")).toBe("2 people");
  expect(plural(1, "person", "people")).toBe("1 person");
});
