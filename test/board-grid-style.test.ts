/**
 * #4833: the grid a board's panels sit in is §5's board, so its rules live in
 * components.ts, once each. What sizes a panel's chart stays in content.ts
 * after `.chart-box`: layers rank above specificity, so in components it
 * would lose to `.chart-box`'s own width and ratio.
 */
import { describe, expect, test } from "bun:test";
import { css } from "../src/web/style.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";

/** How many times `rule` is written in `sheet`. */
const count = (sheet: string, rule: string) => sheet.split(rule).length - 1;

const GRID = [
  ".bgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }",
  ".bp-w2 { grid-column: span 2; }",
  ".bp-w3 { grid-column: span 3; }",
  ".bgrid h2 { font-size: 14px; }",
  "@media (max-width: 720px) { .bgrid { grid-template-columns: minmax(0, 1fr); } .bp-w2, .bp-w3 { grid-column: auto; } }",
];

const SIZING = [
  ".bgrid .chart-box { max-width: none; }",
  ".bp-h2 .chart-box { aspect-ratio: 720 / 400; }",
  ".bp-h3 .chart-box { aspect-ratio: 720 / 540; }",
  ".bp-h2 .chart-box.is-table { height: 400px; }",
  ".bp-h3 .chart-box.is-table { height: 540px; }",
];

describe("the board's panel grid", () => {
  test("each grid rule is in the served stylesheet once, from components.ts", () => {
    for (const rule of GRID) {
      expect(count(css, rule)).toBe(1);
      expect(count(components, rule)).toBe(1);
      expect(count(content, rule)).toBe(0);
    }
  });

  test("each panel's chart sizing is served once, from content.ts after .chart-box.is-table", () => {
    const table = content.indexOf(".chart-box.is-table { aspect-ratio: auto;");
    expect(table).toBeGreaterThan(-1);
    for (const rule of SIZING) {
      expect(count(css, rule)).toBe(1);
      expect(content.indexOf(rule)).toBeGreaterThan(table);
    }
  });
});
