// The terminal's refusals for a private address, a new account's repository
// limit and an origin already connected are said by the modules that own
// them. These tests fail if a copy of one is typed back into a file that
// should import it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN_ALREADY_CONNECTED } from "../src/actions/origins.ts";
import { NEW_ACCOUNT_GUARD_MESSAGE } from "../src/core/capacity.ts";
import { PRIVATE_ADDRESS_REFUSED } from "../src/kernel/address_words.ts";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

const words: [string, string, string, string[]][] = [
  [
    "PRIVATE_ADDRESS_REFUSED",
    PRIVATE_ADDRESS_REFUSED,
    "that address is inside a network, not on the internet",
    ["src/tui/screens/common.ts", "src/http/api.ts"],
  ],
  [
    "NEW_ACCOUNT_GUARD_MESSAGE",
    NEW_ACCOUNT_GUARD_MESSAGE,
    "new accounts cannot create repositories yet",
    ["src/tui/screens/common.ts"],
  ],
  [
    "ORIGIN_ALREADY_CONNECTED",
    ORIGIN_ALREADY_CONNECTED,
    "that account is already connected",
    ["src/tui/screens/common.ts", "src/http/api.ts"],
  ],
];

describe("the terminal's refusals are said from one place", () => {
  for (const [name, value, sentence, files] of words) {
    test(`${name} is the sentence, and non-empty`, () => {
      expect(value.length).toBeGreaterThan(0);
      expect(value).toBe(sentence);
    });
    for (const file of files) {
      test(`${file} imports ${name} rather than typing it`, () => {
        const text = source(file);
        expect(text).toContain(name);
        expect(text).not.toContain(sentence);
      });
    }
  }

  test("actions/origins.ts says its sentence once, in the export", () => {
    const text = source("src/actions/origins.ts");
    expect(text.split(ORIGIN_ALREADY_CONNECTED).length - 1).toBe(1);
  });

  test("core/capacity.ts says its sentence once, in the export", () => {
    const text = source("src/core/capacity.ts");
    expect(text.split(NEW_ACCOUNT_GUARD_MESSAGE).length - 1).toBe(1);
  });
});
