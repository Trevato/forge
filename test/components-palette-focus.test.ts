import { expect, test } from "bun:test";
import { css } from "../src/web/style";
import { components } from "../src/web/style/components";

test("the palette input rings on keyboard focus only, never on :focus", () => {
  expect(components).toContain(".palette .palette-input:focus-visible");
  expect(components).not.toMatch(/\.palette-input:focus\b(?!-)/);
});

test("avatar hues come from one place: components set --av per data-h", () => {
  expect(css).not.toContain("--hue:");
  expect((css.match(/\.avatar\[data-h="\d+"\]/g) ?? []).length).toBe(12);
});

test("the topbar search input is 16px, so iOS does not zoom and the design lint holds", () => {
  expect(components).toMatch(/\.topbar-search input \{[^}]*font-size: 16px/);
});

test("avatar initials stay mostly --fg so they hold 4.5:1 on the tint in every theme", () => {
  expect(components).toContain("var(--av-ink) 28%, var(--fg)");
});
