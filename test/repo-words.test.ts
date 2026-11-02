/**
 * A refused repository name and a failed disk init read the same from
 * migrate, a new app and a new repository, because each says them from
 * src/actions/repo_words.ts. A copy typed back into one of them fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_INIT_FAILED, REPO_NAME_RULES } from "../src/actions/repo_words.ts";

const WORDS = { REPO_NAME_RULES, REPO_INIT_FAILED };
const READERS = ["src/actions/migrate.ts", "src/actions/apps.ts", "src/web/pages/site.ts"];

describe("a repository's refusal words", () => {
  for (const [name, words] of Object.entries(WORDS)) {
    test(`${name} is a sentence`, () => {
      expect(words.trim().length).toBeGreaterThan(0);
    });
  }

  for (const file of READERS) {
    test(`${file} imports the words and types no copy`, () => {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(source).toContain("repo_words.ts");
      for (const words of Object.values(WORDS)) expect(source).not.toContain(words);
    });
  }
});
