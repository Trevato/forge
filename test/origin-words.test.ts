/**
 * Origin browsing's file-or-directory sentences are said from one module
 * (#5586); a copy typed back into a provider fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as words from "../src/origins/words.ts";

const PROVIDERS = [
  "src/origins/providers/forgejo.ts",
  "src/origins/providers/github.ts",
];

const sentences = Object.entries(words) as [string, string][];

test("each sentence is non-empty", () => {
  expect(sentences.length).toBe(7);
  for (const [, s] of sentences) expect(s.trim().length).toBeGreaterThan(0);
});

test("no provider types a sentence out itself", () => {
  for (const file of PROVIDERS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [name, s] of sentences) {
      expect({ file, name, typed: source.includes(s) }).toEqual({ file, name, typed: false });
    }
  }
});
