/**
 * The write-access and gone-pull refusals are written once, in
 * `actions/pull_words.ts`, and every place that says them imports them: a
 * copy typed back into one of the readers fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/actions/pull_words.ts";

const READERS = [
  "src/actions/finish-conflicts.ts",
  "src/web/pages/edit.ts",
  "src/web/pages/pull.ts",
];

const SENTENCES = Object.entries(words) as [string, string][];

describe("pull words", () => {
  test("names both refusals", () => {
    expect(words.NO_WRITE_ACCESS).toBe("You do not have write access to this repository.");
    expect(words.PULL_GONE).toBe("That pull request is no longer here.");
  });

  for (const [name, sentence] of SENTENCES) {
    test(`${name} is a sentence`, () => {
      expect(typeof sentence).toBe("string");
      expect(sentence.trim().length).toBeGreaterThan(0);
    });

    for (const file of READERS) {
      test(`${file} reads ${name} rather than typing it`, () => {
        const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
        expect(source.includes(sentence)).toBe(false);
      });
    }
  }
});
