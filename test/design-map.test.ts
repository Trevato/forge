/**
 * docs/design/map.md names every section of the map page and says keep or
 * cut (#2768): each one kept is in the page source, each one cut is gone
 * from it (#2770). Each entry is a backticked name leading a bullet; this
 * maps it to the text the page carried for it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/design/map.md", "utf8");
// The repository map and its forge-wide lanes (#6310) are one page source.
const src = ["src/web/pages/map.ts", "src/web/pages/global-map.ts"]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

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

const verdicts = new Map(
  [...doc.matchAll(/^- `([^`]+)` —.*\*\*(Keep|Cut)\*\*/gm)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);

test("every section the doc keeps is in the page source", () => {
  for (const name of named)
    if (verdicts.get(name) === "Keep") expect(src).toContain(MARKERS[name]!);
});

test("every section the doc cuts is gone from the page source", () => {
  const cut = named.filter((name) => verdicts.get(name) === "Cut");
  expect(cut.sort()).toEqual(
    ["Autonomy line", "Critical path", "Spend bar", "Two weeks"].sort(),
  );
  for (const name of cut) expect(src).not.toContain(MARKERS[name]!);
});

test("every section says keep or cut", () => {
  for (const line of doc.split("\n").filter((l) => /^- `/.test(l)))
    expect(line).toMatch(/\*\*(Keep|Cut)\*\*/);
});
