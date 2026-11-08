/**
 * A taken username, a reserved name and a missing email are said from one
 * module, src/actions/signup_words.ts. Every door that makes an account or
 * an org imports the sentence; none types its own copy, so a copy typed
 * back fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_WANTED, NAME_RESERVED, USERNAME_TAKEN } from "../src/actions/signup_words.ts";

const ROOT = join(import.meta.dir, "..");

const DOORS = [
  "src/actions/first_admin.ts",
  "src/web/pages/claim.ts",
  "src/web/pages/crew.ts",
  "src/web/pages/everyday.ts",
  "src/actions/orgs.ts",
  "src/web/pages/signup-passkey.ts",
  "src/web/pages/site.ts",
];

const SENTENCES = [USERNAME_TAKEN, NAME_RESERVED, EMAIL_WANTED];

describe("name words", () => {
  test("the module says each sentence as it always read", () => {
    expect(USERNAME_TAKEN).toBe("That username is taken.");
    expect(NAME_RESERVED).toBe("That name is reserved.");
    expect(EMAIL_WANTED).toBe("An email address, please.");
  });

  for (const file of DOORS) {
    test(`${file} types none of the sentences itself`, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const sentence of SENTENCES) expect(text).not.toContain(sentence);
      expect(text).toContain("signup_words.ts");
    });
  }
});
