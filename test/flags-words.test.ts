/**
 * "Flags are set by a forge admin." is said from one place, src/core/flags.ts,
 * so the action, the web page and the terminal cannot drift apart (#5593).
 * Each file that says it is read as text: a copy typed back fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLAGS_ADMIN_ONLY } from "../src/core/flags.ts";

const sentences = { FLAGS_ADMIN_ONLY };
const readers = ["src/actions/flag_winner.ts", "src/web/pages/flags.ts", "src/tui/screens/flags.ts"];

describe("the flag words live in src/core/flags.ts", () => {
  test("each sentence is non-empty", () => {
    for (const words of Object.values(sentences)) expect(words.trim()).not.toBe("");
  });

  test("no reader types a sentence out again; each imports it", () => {
    for (const file of readers) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      for (const [name, words] of Object.entries(sentences)) {
        expect(source).not.toContain(words);
        expect(source).toContain(name);
      }
    }
  });
});
