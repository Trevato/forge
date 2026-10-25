/**
 * Where an ask stands is said from one place (#5619): the asked and answers
 * views, web and terminal, import the sentences from
 * `src/actions/ask_state_words.ts` and never type them out again.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREW_WORKING, NOT_PLACED_YET } from "../src/actions/ask_state_words.ts";

const root = join(import.meta.dir, "..");
const views = [
  "src/web/studio/asked_page.ts",
  "src/tui/screens/asked.ts",
  "src/web/studio/answers.ts",
  "src/tui/screens/answers.ts",
];

test("the sentences read as they always have", () => {
  expect(NOT_PLACED_YET).toBe("the planner has not placed it yet");
  expect(CREW_WORKING).toBe("The crew is working on it.");
});

for (const file of views) {
  test(`${file} imports the ask's state words and types none of them`, () => {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).toContain("actions/ask_state_words.ts");
    for (const sentence of [NOT_PLACED_YET, CREW_WORKING]) expect(text).not.toContain(sentence);
  });
}
