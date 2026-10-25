/**
 * A sign-in flow's expiry sentences are said from one place
 * (`src/kernel/signin_words.ts`). Each is a real sentence, and neither the
 * parent sign-in nor an app's scaffold types its own copy back in.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/kernel/signin_words.ts";

const READERS = ["src/http/rp.ts", "src/apps/scaffold.ts"];
const source = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("a sign-in flow's expiry sentences", () => {
  const sentences = Object.entries(words);

  test("each exported sentence says something", () => {
    expect(sentences.length).toBe(2);
    for (const [, sentence] of sentences) {
      expect(typeof sentence).toBe("string");
      expect(sentence.trim()).not.toBe("");
    }
  });

  for (const path of READERS)
    test(`${path} imports the sentences and types none of them`, () => {
      const text = source(path);
      expect(text).toContain("kernel/signin_words.ts");
      for (const [name, sentence] of sentences) {
        expect(text).toContain(name);
        expect(text).not.toContain(sentence);
      }
    });
});
