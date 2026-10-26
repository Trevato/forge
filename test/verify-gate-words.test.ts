/**
 * An unverified account held back reads the same from every door (page,
 * API, MCP, terminal) because the sentence is said from one place:
 * src/actions/verify_words.ts. Each door imports it; a copy typed back into
 * a door's source fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVE_FIRST, VERIFY_FIRST } from "../src/actions/verify_words.ts";
import { UNVERIFIED_WORDS } from "../src/actions/tell.ts";
import { UNVERIFIED_MESSAGE } from "../src/actions/verify.ts";

const ROOT = join(import.meta.dir, "..");
const DOORS = [
  "src/http/api.ts",
  "src/http/mcp/tools/new_app.ts",
  "src/http/mcp/tools/make_it_yours.ts",
  "src/http/respond.ts",
  "src/actions/tell.ts",
  "src/actions/verify.ts",
  "src/contract/openapi/routes/postApiV1ReposOwnerNameMakeItYours.ts",
  "src/contract/openapi/routes/postApiV1UserOriginsIdBrowseOwnerNameContribute.ts",
];

describe("the words that hold back an unverified account", () => {
  test("the module says each sentence, and the old names read it", () => {
    expect(VERIFY_FIRST).toBe("verify your email first");
    expect(PROVE_FIRST).toBe("prove your email first");
    expect(UNVERIFIED_MESSAGE).toBe(VERIFY_FIRST);
    expect(UNVERIFIED_WORDS).toBe(VERIFY_FIRST);
  });

  for (const file of DOORS) {
    test(`${file} imports the sentences rather than typing them`, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text).toContain("verify_words.ts");
      for (const sentence of [VERIFY_FIRST, PROVE_FIRST]) {
        expect(text.includes(sentence)).toBe(false);
      }
    });
  }
});
