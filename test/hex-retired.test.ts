import { expect, test } from "bun:test";
import { css } from "../src/web/style";
import { shellJs } from "../src/web/client";

test(".hex leaves the stylesheet: the colour readout draws from base's .mono and .muted", () => {
  expect(css).not.toMatch(/\.hex\b/);
  expect(css).toMatch(/(^|[\s,])\.mono\s*\{[^}]*font-family: var\(--mono\)[^}]*font-size: 12\.5px/);
  expect(css).toContain(".muted { color: var(--muted-fg); }");
});

test("the picker script finds the readout by data-hex, not by a style class", () => {
  expect(shellJs).toContain("querySelector('[data-hex]')");
  expect(shellJs).not.toContain("'.hex'");
});
