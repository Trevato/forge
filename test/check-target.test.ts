/** #3924: a checkbox is a 44px target on a coarse pointer, so a grants table on a phone ticks the cell it means. */
import { expect, test } from "bun:test";
import { components } from "../src/web/style/components.ts";

test(".check grows to a 44px target with a 24px box under (pointer: coarse)", () => {
  const block = components.slice(components.indexOf("@media (pointer: coarse) {\n  .check"));
  const rules = block.slice(0, block.indexOf("\n}") + 2);
  expect(rules).toContain(".check { min-height: 44px; min-width: 44px;");
  expect(rules).toContain(".check input { width: 24px; height: 24px; margin: 0; }");
  expect(rules).toContain(".table .check { justify-content: center; }");
});
