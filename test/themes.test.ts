import { describe, expect, test } from "bun:test";
import { bootCss, FIXED_TOKENS, THEME_NAMES, THEMES } from "../src/design/themes.ts";
import { css } from "../src/web/style.ts";

describe("bootCss: the ground before the stylesheet arrives (#1240)", () => {
  test("with no data-theme, the system pair follows the OS", () => {
    expect(bootCss).toStartWith(
      "html,body{background-color:#fafafa;color-scheme:light}" +
        "@media (prefers-color-scheme: dark){html,body{background-color:#09090b;color-scheme:dark}}",
    );
  });

  test("every theme paints its own ground from the attribute, after the media rule", () => {
    const media = bootCss.indexOf("@media");
    for (const name of THEME_NAMES) {
      const t = THEMES[name];
      const rule = `html[data-theme="${name}"],html[data-theme="${name}"] body{background-color:${t.tokens.bg};color-scheme:${t.appearance}}`;
      expect(bootCss).toContain(rule);
      expect(bootCss.indexOf(rule)).toBeGreaterThan(media);
    }
  });

  test("names no theme on its own, so a toggle never leaves a stale ground", () => {
    // Every rule outside the system pair is keyed on data-theme.
    const rest = bootCss.slice(bootCss.indexOf("}}") + 2);
    for (const rule of rest.split("}").filter(Boolean)) {
      expect(rule).toStartWith("html[data-theme=");
    }
  });
});

describe("fixed tokens: colours every theme shares (#2697)", () => {
  test("the stylesheet defines each one, and every var(--series-N|qr-ground) it reads is defined", () => {
    for (const [key, value] of Object.entries(FIXED_TOKENS)) expect(css).toContain(`--${key}: ${value};`);
    for (const m of css.matchAll(/var\(--((?:series-\d+)|qr-ground)\)/g)) {
      expect(Object.keys(FIXED_TOKENS)).toContain(m[1]!);
    }
    expect(css).toContain(".fg-s0 { fill: var(--series-0); color: var(--series-0); }");
  });
});

/**
 * WCAG 2.2 contrast (§1.4.3): relative luminance of sRGB with the 0.04045
 * knee, then (L1 + 0.05) / (L2 + 0.05). By hand, Porcelain's #2563eb on
 * #fafafa: L = 0.1532 and 0.9560, so 1.0060 / 0.2032 ≈ 4.95, the lowest of
 * the six and above the 4.5 that small text needs.
 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the accent as text", () => {
  test("black on white is 21:1, a colour on itself 1:1, Porcelain's accent 4.95", () => {
    expect(contrast("#2563eb", "#fafafa")).toBeCloseTo(4.95, 2);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#2563eb", "#2563eb")).toBe(1);
  });

  // The board's month gap is small text in the accent (#11056): it must read on the ground.
  test.each(THEME_NAMES)("%s: the accent on the ground holds 4.5:1", (name) => {
    const t = THEMES[name].tokens;
    expect(contrast(t.accent, t.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
