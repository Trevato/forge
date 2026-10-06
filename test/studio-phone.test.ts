import { describe, expect, test } from "bun:test";
import { studioCss } from "../src/web/studio/style.ts";

/** The studio's phone rules: mechanical checks; the look is judged by eye. */
describe("the studio at 360px", () => {
  const phone = studioCss.slice(studioCss.indexOf("@media (max-width: 600px) {\n  .studio-head"));

  test("every component the issue names has a phone rule", () => {
    for (const sel of [".studio-head", ".studio-tell", ".fcard-head", ".studio-ask-actions", ".studio-list li", ".studio-word"]) {
      expect(phone).toContain(sel);
    }
  });

  test("decision buttons stack and taps are 44px", () => {
    expect(phone).toContain("flex-direction: column");
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
