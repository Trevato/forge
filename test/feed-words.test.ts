/**
 * The feed's refusals are said from one place (#5648): src/actions/feed_words.ts
 * holds each sentence, and the feed routes and MCP import it rather than
 * typing a copy that could drift.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURSOR_NOT_ISSUED, KIND_HAS_NO_CHIP } from "../src/actions/feed_words.ts";

const ROOT = join(import.meta.dir, "..");
const READERS = [
  "src/http/feed.ts",
  "src/http/mcp/tools/events.ts",
  "src/http/mcp/tools/feed.ts",
  "src/http/mcp/tools/feed_chips.ts",
];

test("the module says each sentence as it always read", () => {
  expect(CURSOR_NOT_ISSUED).toBe("that cursor was not issued here");
  expect(KIND_HAS_NO_CHIP).toBe("that kind has no chip");
});

for (const file of READERS) {
  test(`${file} imports the sentences and types no copy`, () => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).toMatch(/from "(\.\.\/)+actions\/feed_words\.ts"/);
    for (const sentence of [CURSOR_NOT_ISSUED, KIND_HAS_NO_CHIP]) {
      expect(text).not.toContain(sentence);
    }
  });
}
