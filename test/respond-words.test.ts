/**
 * The API's "not found" and "authenticate" sentences are said from one place,
 * `src/http/respond.ts`; the files that say them import them rather than
 * typing a copy that could drift.
 */

import { describe, expect, test } from "bun:test";
import { NOT_FOUND_WORDS, UNAUTHORIZED_WORDS } from "../src/http/respond.ts";

const SENTENCES = { NOT_FOUND_WORDS, UNAUTHORIZED_WORDS };
const READERS = ["src/http/respond.ts", "src/actions/proposal_tokens.ts"];
const root = new URL("..", import.meta.url).pathname;

describe("respond words", () => {
  for (const [name, words] of Object.entries(SENTENCES)) {
    test(`${name} is a sentence`, () => {
      expect(words.trim().length).toBeGreaterThan(0);
    });

    for (const file of READERS) {
      test(`${file} does not type ${name} out`, async () => {
        const source = await Bun.file(root + file).text();
        const typed = source.split(`"${words}"`).length - 1;
        // respond.ts holds the one definition; every other reader has none.
        expect(typed).toBe(file === "src/http/respond.ts" ? 1 : 0);
      });
    }
  }
});
