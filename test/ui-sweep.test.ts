/**
 * The UI sweep (#3698): the type floor is a token, the phone never loses the
 * create menu, the settings strip and the system tables stay in their boxes,
 * and the Live row does not call its 24 h count "active". Source-level: the
 * sandbox has no browser, so the pixel checks at 1440/1024/390 stay with the
 * audit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { feedJs } from "../src/web/studio/feed.ts";
import { css } from "../src/web/style.ts";
import { mapCss } from "../src/web/pages/map.ts";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("type floor", () => {
  test("no declared font-size is under 12px", () => {
    for (const sheet of [css, mapCss]) {
      for (const m of sheet.matchAll(/font-size:\s*([0-9.]+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
      expect(sheet).not.toMatch(/font-size:\s*0?\.[0-9]+(em|rem)/);
    }
  });
  test("the floor is one token", () => {
    expect(css).toContain("--fs-min: 12px");
  });
});

describe("layout", () => {
  test("the + menu is not hidden on a phone", () => {
    expect(read("src/web/layout.ts")).not.toContain('<span class="hide-sm">${newMenu(ctx)}');
  });
  test("settings grid and tab strips may shrink below their content", () => {
    expect(css).toMatch(/\.settings \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.settings-nav \{\s*min-width: 0/);
    expect(css).toMatch(/\.tabs \{\s*min-width: 0/);
  });
  test("the system page's pills wrap and its tables scroll inside a box", () => {
    expect(css).toContain("#summary { display: flex; flex-wrap: wrap");
    expect(read("src/web/pages/system.ts")).toContain('<div class="table-scroll"><table class="table" aria-label="Forge memory by hour">');
  });
  test("the processes table scrolls in §5's .table-scroll and .table-wrap is gone", () => {
    const sys = read("src/web/pages/system.ts");
    expect(sys).toContain('<div class="table-scroll"><table class="table" data-dense aria-label="Processes by what launched them">');
    expect(sys).not.toContain("table-wrap");
    expect(css).not.toContain("table-wrap");
    expect(css).toMatch(/\.table-scroll \{[^}]*overflow-x: auto/);
  });
  test("a pressed button looks pressed", () => {
    expect(css).toContain('.btn[aria-pressed="true"]');
  });
});

describe("flow panel", () => {
  const src = read("src/web/pages/flow-panel.ts");
  test("the summary is a section of its own, and Live shows no 'active' count", () => {
    expect(src).toContain('<section class="bd-now" id="flow-summary"');
    expect(src).toContain('s.key === "live" ? "—"');
  });
});

describe("home feed", () => {
  test("acting says what it did", () => {
    expect(feedJs).toContain("Dismissed.");
    expect(feedJs).toContain("'Muted '");
  });
  test("no button uses a class the stylesheet lacks", () => {
    for (const f of ["src/web/studio/feed.ts", "src/web/studio/asks_page.ts", "src/web/studio/home.ts", "src/web/pages/thread.ts"])
      expect(read(f)).not.toMatch(/btn-(sm|ghost|xs)/);
  });
});
