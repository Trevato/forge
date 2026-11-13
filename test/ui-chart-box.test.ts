/**
 * The chart frame (#4282): `chartBox()` is the one place `.chart-box` is
 * written, around `drawChart`'s svg, with `.is-table` for a table panel.
 * /system and the board pages assert they send this frame in their own tests.
 */
import { describe, expect, test } from "bun:test";
import { drawChart } from "../src/boards/chart.ts";
import { chartBox } from "../src/web/ui.ts";

const cells = [{ label: "a", value: 1 }, { label: "b", value: 2 }];

describe("chartBox", () => {
  test("wraps drawChart's svg in the frame", () => {
    expect(String(chartBox("line", cells, "Runs"))).toBe(`<div class="chart-box">${drawChart("line", cells, "Runs")}</div>`);
    expect(String(chartBox("number", cells, "Runs"))).toMatch(/^<div class="chart-box"><div class="chart" data-chart="number"[\s\S]*<span class="big num">2<\/span>/);
  });

  test("a table panel carries is-table", () => {
    expect(String(chartBox("table", cells, "Runs"))).toStartWith(`<div class="chart-box is-table">`);
    expect(String(chartBox("bar", cells, "Runs"))).not.toContain("is-table");
  });

  test("the title is escaped", () => {
    expect(String(chartBox("line", cells, `<script>"`))).not.toContain("<script>");
  });
});
