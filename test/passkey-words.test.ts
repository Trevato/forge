import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/web/passkey-words.ts";

const READERS = ["src/web/pages/passkeys.ts", "src/web/pages/signup-passkey.ts", "src/web/passkey-ceremony.ts"];
const sentences = Object.entries(words) as [string, string][];

describe("passkey ceremony words", () => {
  test("names the three sentences, each non-empty", () => {
    expect(Object.keys(words).sort()).toEqual(["PASSKEY_EXPIRED", "PASSKEY_REJECTED", "PASSKEY_TAKEN"]);
    for (const [, sentence] of sentences) expect(sentence.trim().length).toBeGreaterThan(0);
  });

  for (const file of READERS)
    test(`${file} reads them from the module, typing none out`, () => {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(source).toContain("passkey-words.ts");
      for (const [name, sentence] of sentences) expect({ name, typed: source.includes(sentence) }).toEqual({ name, typed: false });
    });
});
