import { describe, expect, test } from "bun:test";
import { studioCss } from "../src/web/studio/style.ts";

/** The studio's phone rules: mechanical checks; the look is judged by eye. */
describe("the studio at 360px", () => {
  const phone = studioCss.slice(studioCss.lastIndexOf("@media (max-width: 600px) {"));

  test("every component the issue names has a phone rule", () => {
    for (const sel of [".feed .card-head", ".feed .bar .btn"]) {
      expect(phone).toContain(sel);
    }
  });

  test("taps are 44px", () => {
    expect(phone).toContain("min-height: 44px");
  });

  test("no studio rule fixes a pixel width above 360", () => {
    for (const m of studioCss.matchAll(/(?<![-\w])(?:min-|max-)?width:\s*(\d+)px(?!\))/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(360);
    }
  });

  test("phone rules live only inside a media query", () => {
    expect(phone.startsWith("@media")).toBe(true);
  });
});

describe("home's moving lists stay inside the screen (#8681)", () => {
  const css = studioCss;

  test("the columns may shrink below their content, so a long title ellipsizes", () => {
    expect(css).toContain(".moving { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain(".moving > * { min-width: 0; }");
    expect(css).not.toMatch(/\.moving \{[^}]*grid-template-columns: 1fr/);
  });
});
