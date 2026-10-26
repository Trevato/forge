/**
 * The waves and decider sentences are typed once, in src/story/words.ts
 * (#5622): the pages and screens that say them import them, and a copy typed
 * back into any of them fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_WAVES, deciderSentence } from "../src/story/words.ts";

const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

const SAYERS = [
  "src/web/pages/waves.ts",
  "src/tui/screens/waves.ts",
  "src/web/pages/board.ts",
  "src/tui/screens/decider.ts",
];

test("the sentences read as they always have", () => {
  expect(NO_WAVES).toBe("This repository has no waves/ directory.");
  const n = { closed: 4, deferred: 2, asked: 1 };
  expect(deciderSentence((p) => n[p]).join("")).toBe(
    "The decider closed 4, deferred 2, asked you about 1.",
  );
});

for (const file of SAYERS) {
  test(`${file} says them from words.ts, not as its own copy`, () => {
    const text = read(file);
    expect(text).toContain("story/words.ts");
    expect(text).not.toContain("no waves/ directory");
    expect(text).not.toContain("The decider closed");
    expect(text).not.toMatch(/deferred [^,]*, asked\s+you\s+about/);
  });
}
