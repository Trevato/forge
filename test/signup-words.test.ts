import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_TAKEN_MESSAGE, INVALID_USERNAME_MESSAGE } from "../src/actions/signup_words.ts";

const SENTENCES = { INVALID_USERNAME_MESSAGE, EMAIL_TAKEN_MESSAGE };

const READERS = [
  "src/actions/first_admin.ts",
  "src/web/pages/claim.ts",
  "src/web/pages/everyday.ts",
  "src/web/pages/signup-passkey.ts",
  "src/web/pages/site.ts",
];

describe("signup words", () => {
  for (const [name, sentence] of Object.entries(SENTENCES))
    test(`${name} is a sentence`, () => {
      expect(sentence.trim().length).toBeGreaterThan(0);
    });

  for (const file of READERS)
    test(`${file} reads the sentences rather than typing them`, () => {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      for (const sentence of Object.values(SENTENCES)) expect(source).not.toContain(sentence);
      expect(source).toContain("signup_words.ts");
    });
});
