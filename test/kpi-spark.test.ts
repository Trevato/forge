/**
 * The KPI sparklines (#3238): `daySpark` breaks the line at a day with no
 * data, and the two numbers-only helpers draw exactly what they did before.
 * Expected points are worked by hand on the 96 × 24 box: x = i · 96 / (n − 1),
 * y = 22 − (v / top) · 20 with top = max(1, …values).
 */

import { describe, expect, test } from "bun:test";
import { daySpark, sparkline } from "../src/web/studio/kpi_row.ts";

const LINE = 'fill="none" stroke="currentColor" stroke-width="1.5"';

describe("daySpark", () => {
  test("a null between two runs of two draws two polylines in one svg", () => {
    const out = daySpark([1, 2, null, 3, 4], "Days")!.toString();
    // top 4, step 24: 1 → 17.0, 2 → 12.0, 3 → 7.0, 4 → 2.0
    expect(out.match(/<svg/g)).toHaveLength(1);
    expect(out).toContain(`<polyline points="0.0,17.0 24.0,12.0" ${LINE}/>`);
    expect(out).toContain(`<polyline points="72.0,7.0 96.0,2.0" ${LINE}/>`);
    expect(out).not.toContain(",22.0"); // the missing day is not drawn as a zero
  });

  test("[1, null, 3, 4]: the lone first day is a dot, the rest one polyline, nothing at zero", () => {
    const out = daySpark([1, null, 3, 4], "Days")!.toString();
    // top 4, step 32: 1 → (0, 17.0), 3 → (64, 7.0), 4 → (96, 2.0)
    expect(out.match(/<polyline/g)).toHaveLength(1);
    expect(out.match(/<circle/g)).toHaveLength(1);
    expect(out).toContain('<circle cx="0.0" cy="17.0" r="1.5" fill="currentColor"/>');
    expect(out).toContain(`<polyline points="64.0,7.0 96.0,2.0" ${LINE}/>`);
    expect(out).not.toContain(",22.0");
  });

  test("all null is no sparkline at all", () => {
    expect(daySpark([null, null], "Days")).toBeNull();
    expect(daySpark([], "Days")).toBeNull();
  });

  test("it carries no class, keeps the box and currentColor, and adds no style or colour", () => {
    const out = daySpark([0, null, 5], "Days")!.toString();
    expect(out).toStartWith('<svg viewBox="0 0 96 24" width="96" height="24" role="img" aria-label="Days">');
    expect(out).not.toContain("style=");
    expect(out).not.toContain("class=");
    expect(out).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
  });

  test("the label is escaped", () => {
    expect(daySpark([1], 'a"<b>')!.toString()).toContain('aria-label="a&quot;&lt;b&gt;"');
  });
});

describe("the numbers-only sparklines are unchanged", () => {
  test("sparkline, newest first in, oldest on the left", () => {
    expect(sparkline([2, 0]).toString()).toBe(
      `<svg viewBox="0 0 96 24" width="96" height="24" role="img" aria-label="Shipped each hour over the last 24 hours"><polyline points="0.0,22.0 96.0,2.0" ${LINE}/></svg>`,
    );
  });
});
