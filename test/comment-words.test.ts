/**
 * A comment's refusals are said from one place (#5588): the module owns
 * each sentence and no page types its own copy.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/actions/comment_words.ts";

const sentences = Object.values(words);
const readers = ["src/web/pages/issues.ts", "src/web/pages/pull.ts", "src/web/studio/toolbar.ts"];

test("each sentence is non-empty", () => {
  expect(sentences).toEqual(["A comment needs something in it.", "That comment could not be posted."]);
  for (const s of sentences) expect(s.trim().length).toBeGreaterThan(0);
});

test("no reader types a copy of a sentence", () => {
  for (const file of readers) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(source).toContain("actions/comment_words.ts");
    for (const s of sentences) expect(source.includes(s)).toBe(false);
  }
});
