/**
 * Why a run waits for a builder is said from one module (#5652):
 * `src/crew/words.ts` holds each sentence, and the passes that report it
 * import it rather than typing it again. Read as text, so a copy typed
 * back into either file fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_BUILDER_ON_CREW, WAITS_FOR_BUILDER_SLOT } from "../src/crew/words.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const SENTENCES = [
  ["WAITS_FOR_BUILDER_SLOT", WAITS_FOR_BUILDER_SLOT, "waits for a builder slot"],
  ["NO_BUILDER_ON_CREW", NO_BUILDER_ON_CREW, "no builder on the crew"],
] as const;

const READERS = ["src/crew/finishing.ts", "src/crew/requested.ts"] as const;

describe("why a run waits for a builder, said once", () => {
  test("the module says each sentence, word for word", () => {
    for (const [, said, words] of SENTENCES) expect(said).toBe(words);
  });

  for (const file of READERS) {
    test(`${file} imports the sentences and types none of them`, () => {
      const text = read(file);
      expect(text).toContain('from "./words.ts"');
      for (const [name, said] of SENTENCES) {
        expect(text).toContain(name);
        expect(text).not.toContain(said);
      }
    });
  }
});
