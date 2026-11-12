import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FIRST_FIVE_MINUTES, STRANGER_NEVER_SEES } from "../src/design/first_five_minutes.ts";

const doc = readFileSync(new URL("../docs/DESIGN.md", import.meta.url), "utf8");

test("DESIGN.md names the closed list of words, once, as the data holds it", () => {
  expect(doc).toContain(`Words a stranger is never shown on this path: ${STRANGER_NEVER_SEES.join(", ")}.`);
});

test("DESIGN.md states the budgets the data holds", () => {
  const b = FIRST_FIVE_MINUTES;
  expect(doc).toContain(`at most ${["zero", "one", "two", "three"][b.screensBeforeForge]} screens before the forge`);
  expect(doc).toContain(`under ${b.forgeReadySeconds} s`);
  expect(doc).toContain(`under ${b.firstCrewActivitySeconds} s`);
  expect(b.changeLiveSeconds / 60).toBe(5);
});
