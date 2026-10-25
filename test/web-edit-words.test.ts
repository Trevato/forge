/**
 * "That file is too large to edit here." and "That could not be changed."
 * are said from src/web/edit_words.ts alone (#5625): every page that says
 * one imports it, and a copy typed back into a page fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_CHANGED, TOO_LARGE_TO_EDIT } from "../src/web/edit_words.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const SAYERS: ReadonlyArray<{ path: string; words: string; name: string }> = [
  { path: "src/web/pages/browse.ts", words: TOO_LARGE_TO_EDIT, name: "TOO_LARGE_TO_EDIT" },
  { path: "src/web/pages/edit.ts", words: TOO_LARGE_TO_EDIT, name: "TOO_LARGE_TO_EDIT" },
  { path: "src/web/pages/settings.ts", words: NOT_CHANGED, name: "NOT_CHANGED" },
  { path: "src/web/pages/thread.ts", words: NOT_CHANGED, name: "NOT_CHANGED" },
];

describe("edit words live in one module", () => {
  test("the sentences read as they always have", () => {
    expect(TOO_LARGE_TO_EDIT).toBe("That file is too large to edit here.");
    expect(NOT_CHANGED).toBe("That could not be changed.");
  });

  for (const { path, words, name } of SAYERS) {
    test(`${path} imports ${name} and types no copy of it`, () => {
      const text = read(path);
      expect(text).not.toContain(words);
      expect(text).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\.\\./edit_words\\.ts"`));
    });
  }
});
