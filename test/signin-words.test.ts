/**
 * A sign-in flow's expiry sentences are said from one place
 * (`src/kernel/signin_words.ts`). Each is a real sentence, and neither the
 * parent sign-in nor an app's scaffold types its own copy back in.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bakedTemplate } from "../src/apps/template.ts";
import * as words from "../src/kernel/signin_words.ts";

const READERS = ["src/http/rp.ts"];
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

describe("the app template says the same sentences", () => {
  test("its sign-in carries each one verbatim", () => {
    const signin = bakedTemplate().files.find((f) => f.path === "src/signin.ts")?.content;
    expect(typeof signin).toBe("string");
    for (const [, sentence] of Object.entries(words)) expect(signin as string).toContain(sentence);
  });
});
