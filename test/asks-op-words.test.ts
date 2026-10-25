/**
 * An ask that moved on, an unknown bulk operation and a milestone not here
 * are said from src/actions/asks_words.ts (#5654): the files that answer
 * with them import the sentence and never type a copy of it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_LONGER_ASKS,
  NO_SUCH_MILESTONE,
  NO_SUCH_OPERATION,
} from "../src/actions/asks_words.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const SAID_BY: [string, string, string[]][] = [
  ["NO_LONGER_ASKS", NO_LONGER_ASKS, ["src/actions/asks_decide.ts", "src/web/studio/asks.ts"]],
  ["NO_SUCH_OPERATION", NO_SUCH_OPERATION, ["src/actions/asks_bulk.ts", "src/actions/fleet.ts"]],
  ["NO_SUCH_MILESTONE", NO_SUCH_MILESTONE, ["src/actions/limb_replan.ts", "src/actions/limbs.ts"]],
];

test("the sentences read as they always have", () => {
  expect(NO_LONGER_ASKS).toBe("it no longer asks you");
  expect(NO_SUCH_OPERATION).toBe("no such operation here");
  expect(NO_SUCH_MILESTONE).toBe("no such milestone here");
});

for (const [name, sentence, files] of SAID_BY) {
  for (const file of files) {
    test(`${file} imports ${name} and types no copy of it`, () => {
      const text = read(file);
      expect(text).not.toContain(sentence);
      expect(text).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "[./]+(actions/)?asks_words\\.ts"`));
    });
  }
}
