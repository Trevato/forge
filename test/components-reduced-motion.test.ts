import { expect, test } from "bun:test";
import { components } from "../src/web/style/components";

const block = components.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/)?.[1] ?? "";

test("reduced motion collapses every animation and transition, and wins over class rules", () => {
  expect(block).toContain("*, *::before, *::after");
  for (const d of ["animation-duration: .01ms", "animation-iteration-count: 1", "transition-duration: .01ms"]) {
    expect(block).toContain(`${d} !important;`);
  }
});

test("reduced motion leaves animationend firing (live.ts clears its flash class on it)", () => {
  expect(block).not.toMatch(/animation\s*:\s*none/);
});

test("a busy loader has a static look under reduced motion", () => {
  expect(block).toContain('.btn[aria-busy="true"] .ico-loader { opacity: .6; }');
});
