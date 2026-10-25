/**
 * A pull's re-check and conflict sentences are said from one module
 * (#5620): the pull page, the conflicts page and the terminal import them,
 * and none of them types a copy back.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_ASKED, RESOLUTION_ASKED } from "../src/actions/pull_ask_words.ts";

const ROOT = join(import.meta.dir, "..");
const READERS = [
  "src/web/pages/pull.ts",
  "src/web/pages/conflicts.ts",
  "src/tui/screens/stalled.ts",
  "src/tui/screens/pull.ts",
];

test("the sentences read as they always have", () => {
  expect(CHECK_ASKED).toBe("Check asked for at the current head.");
  expect(RESOLUTION_ASKED).toBe("Asked: the crew is resolving it on the pull's own branch.");
});

test("every reader imports the module and types no copy of a sentence", () => {
  for (const path of READERS) {
    const text = readFileSync(join(ROOT, path), "utf8");
    expect(text).toContain("actions/pull_ask_words.ts");
    for (const sentence of [CHECK_ASKED, RESOLUTION_ASKED]) {
      expect({ path, has: text.includes(sentence) }).toEqual({ path, has: false });
    }
  }
});
