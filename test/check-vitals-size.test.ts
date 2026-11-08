/** A look's recorded size: kept by the parser, shown as screens, and named when a phone look scrolls sideways (#9320). */

import { expect, test } from "bun:test";
import { parseLooks } from "../src/checks/looks.ts";
import { sidewaysLine, vitalsRows } from "../src/checks/summary.ts";
import { vitalsLine } from "../src/checks/progress.ts";
import { vitalsTable } from "../src/web/studio/vitals.ts";

const size = (scrollWidth: number, scrollHeight: number) => ({ scrollWidth, scrollHeight, innerWidth: 390, innerHeight: 800 });

test("a valid size survives parsing; a broken one is dropped", () => {
  const [a, b] = parseLooks([
    { look: "phone", entries: {}, size: size(390, 1000) },
    { look: "phone /x", entries: {}, size: { scrollWidth: "wide" } },
  ]);
  expect(a).toMatchObject({ size: size(390, 1000) });
  expect(b).toEqual({ look: "phone /x", entries: {} });
});

test("screens is scrollHeight over innerHeight to one decimal", () => {
  const g = vitalsRows([{ look: "phone", entries: {}, size: size(390, 2000) }, { look: "desktop", entries: {} }]);
  expect(g[0]!.screens).toBe("2.5");
  expect(g[1]!.screens).toBe("");
  expect(vitalsTable([{ look: "phone", entries: {}, size: size(390, 1000) }]).toString()).toContain(">1.3<");
});

test("the sideways line names a wide phone look and only that", () => {
  const wide = { look: "phone /preview-admin/sample/held", entries: {}, size: size(500, 800) };
  expect(sidewaysLine(vitalsRows([wide]))).toBe("phone /preview-admin/sample/held scrolls sideways");
  expect(vitalsTable([wide]).toString()).toContain("phone /preview-admin/sample/held scrolls sideways");
  const fits = { look: "phone", entries: {}, size: size(390, 800) };
  const desktop = { look: "desktop", entries: {}, size: size(2000, 800) };
  const none = { look: "phone /y", entries: {} };
  expect(sidewaysLine(vitalsRows([fits, desktop, none]))).toBe("");
  expect(vitalsTable([fits, desktop, none]).toString()).not.toContain("sideways");
});

test("the terminal line carries screens and the sideways note", () => {
  const wide = { look: "phone /x", entries: {}, size: size(500, 1600) };
  const line = vitalsLine([wide, { look: "desktop", skipped: "no browser" }]);
  expect(line).toContain("phone /x:");
  expect(line).toContain("2.0 screens");
  expect(line).toContain("desktop: skipped: no browser · phone /x scrolls sideways");
  expect(vitalsLine([{ look: "phone", entries: {} }])).not.toContain("screens");
});
