/**
 * A branch's sentences are typed once, in `src/actions/branch_words.ts`
 * (#5713), and the branches page, the MCP and the terminal read
 * them from there. This fails if a copy of a sentence is typed back.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRANCH_NOT_CREATED,
  BRANCH_NOT_DELETED,
  NAME_THE_BRANCH,
} from "../src/actions/branch_words.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const SENTENCES = {
  BRANCH_NOT_CREATED: "That branch was not created.",
  BRANCH_NOT_DELETED: "That branch was not deleted.",
  NAME_THE_BRANCH: "give the branch a name",
} as const;

/** Each file, and the sentences it reads by name. */
const READERS: Record<string, readonly (keyof typeof SENTENCES)[]> = {
  "src/web/pages/branches.ts": ["BRANCH_NOT_CREATED", "BRANCH_NOT_DELETED"],
  "src/http/mcp.ts": ["BRANCH_NOT_CREATED", "BRANCH_NOT_DELETED"],
  "src/tui/screens/refs.ts": ["NAME_THE_BRANCH"],
  "src/tui/screens/workspace.ts": ["NAME_THE_BRANCH"],
};

describe("a branch's words", () => {
  test("the module says each sentence, word for word", () => {
    expect({ BRANCH_NOT_CREATED, BRANCH_NOT_DELETED, NAME_THE_BRANCH }).toEqual({
      ...SENTENCES,
    });
  });

  for (const [file, names] of Object.entries(READERS)) {
    test(`${file} types none of the sentences and names the ones it says`, () => {
      const text = read(file);
      for (const sentence of Object.values(SENTENCES)) expect(text).not.toContain(sentence);
      for (const name of names) expect(text).toContain(name);
    });
  }
});
