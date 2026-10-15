import { describe, expect, test } from "bun:test";
import { bootCss, THEME_NAMES, THEMES } from "../src/design/themes.ts";

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
