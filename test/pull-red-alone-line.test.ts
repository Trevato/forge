import { expect, test } from "bun:test";
import { redAloneLine } from "../src/web/pages/pull.ts";

const mark = { at: "2026-10-26T20:41:30.000Z", head: "a".repeat(40), base: "b".repeat(40) };

test("a pull held as red alone says so, with a <time> element", () => {
  const line = redAloneLine(mark).text;
  expect(line).toContain("red alone at");
  expect(line).toContain('<time datetime="2026-10-26T20:41:30.000Z">2026-10-26 20:41 UTC</time>');
  expect(line).toContain("waiting for a new head or a new main");
});

test("an unmarked pull draws nothing, and a mark with a broken time neither", () => {
  expect(redAloneLine(undefined).text).toBe("");
  expect(redAloneLine({ ...mark, at: "<script>" }).text).toBe("");
});
