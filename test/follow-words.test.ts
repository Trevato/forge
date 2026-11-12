/**
 * Following's refusals are typed once, in `src/actions/follow_words.ts`
 * (#5589), and the chain and following pages read them from there. This
 * fails if a copy of a sentence is typed back into either page.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOLLOWS_NOTHING, PROPOSE_NEEDS_WRITE } from "../src/actions/follow_words.ts";

const SENTENCES = { FOLLOWS_NOTHING, PROPOSE_NEEDS_WRITE };
const READERS = ["src/web/pages/chain.ts", "src/web/pages/following.ts"];

describe("following's words", () => {
  for (const [name, sentence] of Object.entries(SENTENCES)) {
    test(`${name} is a sentence`, () => {
      expect(sentence.trim().length).toBeGreaterThan(0);
    });
    for (const file of READERS) {
      test(`${file} reads ${name} rather than typing it`, () => {
        const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
        expect(source).not.toContain(sentence);
        // The propose refusal reaches the pages through `proposeRefusalWords`.
        const reads = name === "PROPOSE_NEEDS_WRITE" && file.endsWith("following.ts") ? "proposeRefusalWords" : name;
        expect(source).toContain(reads);
      });
    }
  }
});
