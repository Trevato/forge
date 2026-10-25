/**
 * A repository's danger-zone labels are said once, in src/web/danger_words.ts
 * (#5657). The pages that show them import them; a copy typed back into one
 * of them fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DELETE_REPO, STOP_APP } from "../src/web/danger_words.ts";

const root = join(import.meta.dir, "..");
const readers = ["src/web/pages/settings.ts", "src/web/pages/search.ts"];

test("the module says each sentence as it always read", () => {
  expect(STOP_APP).toBe("Stop running as an app");
  expect(DELETE_REPO).toBe("Delete this repository");
});

test("no file that shows them types a sentence out again", () => {
  for (const file of readers) {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).toContain('from "../danger_words.ts"');
    for (const sentence of [STOP_APP, DELETE_REPO]) {
      expect({ file, has: text.includes(sentence) }).toEqual({ file, has: false });
    }
  }
});
