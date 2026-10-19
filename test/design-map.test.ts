/**
 * docs/design/map.md names every section of the map page, and each one is
 * still in the page source (#2768). Each entry is a backticked name leading a
 * bullet; this maps it to the text the page carries for it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/design/map.md", "utf8");
const src = readFileSync("src/web/pages/map.ts", "utf8");

const MARKERS: Record<string, string> = {
  "Map canvas": 'id: "map-canvas"',
  "Counts line": "function countsLine",
  "Autonomy line": "function autonomyLine",
  "By pillar": "<h2>By pillar</h2>",
  "Ready now": '"Ready now"',
  "Blocked on": '"Blocked on"',
  "Critical path": "<h2>Critical path</h2>",
  "Two weeks": "<h2>Two weeks</h2>",
  Lanes: "function laneHtml",
  "Spend bar": "function spendBar",
};

const named = [...doc.matchAll(/^- `([^`]+)` —/gm)].map((m) => m[1]!);

test("the doc names every section it knows, and no other", () => {
  expect(named.sort()).toEqual(Object.keys(MARKERS).sort());
});

test("every section the doc names is in the page source", () => {
  for (const name of named) expect(src).toContain(MARKERS[name]!);
});

test("every section says keep or cut", () => {
  for (const line of doc.split("\n").filter((l) => /^- `/.test(l)))
    expect(line).toMatch(/\*\*(Keep|Cut)\*\*/);
});
