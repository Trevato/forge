import { expect, test } from "bun:test";
import { oneLine, REASON_MAX } from "../src/crew/handed";
import { directionLine } from "../src/crew/vision";

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("a parked reason with an emoji at characters 139–140 keeps it whole", () => {
  const reason = `${"a".repeat(138)}🙂${"b".repeat(60)}`;
  expect(reason.length).toBe(200);
  const line = oneLine(reason);
  expect(loneSurrogate.test(line)).toBe(false);
  expect(line).toBe(`${"a".repeat(138)}🙂…`);
  expect(Array.from(line).length).toBe(REASON_MAX);
});

test("a short reason is folded to one line and left whole", () => {
  expect(oneLine("  parked \n twice  ")).toBe("parked twice");
});

test("a direction line cut across an emoji leaves no lone surrogate", () => {
  const line = directionLine(`${"a".repeat(238)}🙂${"b".repeat(60)}`, "t1", new Date("2026-10-27T00:00:00Z"));
  expect(loneSurrogate.test(line)).toBe(false);
  expect(line).toBe(`- 2026-10-27: ${"a".repeat(238)}🙂… (thought \`t1\`)`);
});
