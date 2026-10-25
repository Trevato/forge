/**
 * An origin provider's failures are said from src/origins/words.ts alone:
 * no provider types a copy of a sentence back in, so the next edit to the
 * words cannot leave one door saying the old ones.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_ACCOUNT, NO_REVIEW, NOT_A_PATH } from "../src/origins/words.ts";

const providers = [
  "src/origins/providers/forgejo.ts",
  "src/origins/providers/github.ts",
];

describe("an origin provider's failure words", () => {
  test("say the sentences as they were", () => {
    expect([NO_ACCOUNT, NOT_A_PATH, NO_REVIEW]).toEqual([
      "the origin named no account",
      "not a path in a repository",
      "the origin returned no review",
    ]);
  });

  for (const file of providers) {
    test(`${file} imports them and types none of them out`, () => {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(text).toContain('from "../words.ts"');
      for (const sentence of [NO_ACCOUNT, NOT_A_PATH, NO_REVIEW]) {
        expect(text).not.toContain(sentence);
      }
    });
  }
});
