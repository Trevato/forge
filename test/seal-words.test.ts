/**
 * "That could not be sealed." is said from `src/kernel/seal_words.ts` and
 * nowhere else: the destination and the mirror import it, and a copy typed
 * back into either fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_SEALED } from "../src/kernel/seal_words.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the words for a credential that could not be sealed", () => {
  test("the module says them as they were said", () => {
    expect(NOT_SEALED).toBe("That could not be sealed.");
  });

  for (const path of ["src/actions/destination.ts", "src/actions/mirror.ts"]) {
    test(`${path} imports them and types no copy`, () => {
      const text = read(path);
      expect(text).not.toContain(NOT_SEALED);
      expect(text).toContain('from "../kernel/seal_words.ts"');
    });
  }
});
