/**
 * A mirror's "do it there" sentence is said from one module (#5591): the
 * issue teams action and the thread page import it, and neither types a
 * copy of it back.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/actions/mirror_words.ts";

const READERS = ["src/actions/issue_teams.ts", "src/web/pages/thread.ts"];

describe("a mirror's words live in one module", () => {
  const sentences = Object.entries(words);

  test("each exported sentence is a non-empty string", () => {
    expect(sentences.length).toBeGreaterThan(0);
    for (const [, sentence] of sentences) {
      expect(typeof sentence).toBe("string");
      expect((sentence as string).trim()).not.toBe("");
    }
  });

  for (const file of READERS) {
    test(`${file} imports the sentences and types none of them`, () => {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(source).toContain("mirror_words.ts");
      for (const [name, sentence] of sentences) {
        expect(source).toContain(name);
        expect(source).not.toContain(sentence as string);
      }
    });
  }
});
