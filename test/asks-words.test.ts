/** "sign in to act on your asks" is typed once, in actions/asks_words.ts (#5614). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGN_IN_TO_ACT } from "../src/actions/asks_words.ts";

const READERS = ["asks_bulk.ts", "asks_decide.ts", "proposals.ts"];
const text = (file: string) => readFileSync(join(import.meta.dir, "../src/actions", file), "utf8");

describe("asks words", () => {
  test("the sentence reads as it always has", () => {
    expect(SIGN_IN_TO_ACT).toBe("sign in to act on your asks");
  });

  for (const file of READERS) {
    test(`${file} imports the sentence and types no copy of it`, () => {
      const source = text(file);
      expect(source).not.toContain(SIGN_IN_TO_ACT);
      expect(source).toMatch(/import \{[^}]*\bSIGN_IN_TO_ACT\b[^}]*\} from "\.\/asks_words\.ts";/);
    });
  }
});
