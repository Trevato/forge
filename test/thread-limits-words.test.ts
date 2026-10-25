/**
 * A new issue's and pull's length limits are said from one module (#5587):
 * the issue form and the pull form import the sentences, and neither types
 * a copy back.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/actions/thread_limits_words.ts";

const sentences = Object.entries(words) as [string, string][];
const readers = ["src/web/pages/issues.ts", "src/web/pages/pulls.ts"];

test("each sentence is said, and not empty", () => {
  expect(sentences.length).toBe(2);
  for (const [name, sentence] of sentences) {
    expect(typeof sentence, name).toBe("string");
    expect(sentence.trim().length, name).toBeGreaterThan(0);
  }
});

test("the forms import the sentences and type no copy of them", () => {
  for (const file of readers) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(source, file).toContain("actions/thread_limits_words.ts");
    for (const [, sentence] of sentences) {
      expect(source.includes(sentence), `${file}: ${sentence}`).toBe(false);
    }
  }
});
