/**
 * A tell's sentences live in one module (#5650): every door that says one
 * imports it from src/actions/tell_words.ts, so a copy typed back into a
 * page, a screen or the browser's script fails here before it drifts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_SENT_WORDS,
  NOT_TOLD_FROM_WORDS,
  NOT_TOLD_WORDS,
  SAY_SOMETHING_WORDS,
} from "../src/actions/tell_words.ts";

const SENTENCES = {
  NOT_TOLD_WORDS: "That could not be told.",
  NOT_TOLD_FROM_WORDS: "That page could not be told from.",
  SAY_SOMETHING_WORDS: "Say something first.",
  NOT_SENT_WORDS: "That could not be sent.",
};

const DOORS = [
  "src/actions/steer_words.ts",
  "src/web/studio/actions.ts",
  "src/tui/screens/tell.ts",
  "src/tui/screens/report.ts",
  "src/web/studio/toolbar.ts",
  "src/web/client.ts",
];

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("tell words", () => {
  test("the module says each sentence word for word", () => {
    expect({ NOT_TOLD_WORDS, NOT_TOLD_FROM_WORDS, SAY_SOMETHING_WORDS, NOT_SENT_WORDS }).toEqual(SENTENCES);
  });

  for (const door of DOORS) {
    test(`${door} types none of them out`, () => {
      const text = read(door);
      for (const sentence of Object.values(SENTENCES)) expect(text).not.toContain(sentence);
      expect(text).toMatch(/tell_words\.ts/);
    });
  }

  test("the browser's script still says the fallback", async () => {
    const { shellJs } = await import("../src/web/client.ts");
    expect(shellJs).toContain(`note.textContent = '${NOT_TOLD_WORDS}';`);
  });

  const STEER_DOORS = ["src/web/pages/runs.ts", "src/tui/screens/runlist.ts", "src/http/mcp/tools/steer.ts"];
  for (const door of STEER_DOORS) {
    test(`${door} reads the steer refusals from steer_words.ts, typing none out`, () => {
      const text = read(door);
      for (const sentence of [
        "Only an agent's run can be steered.",
        "You need write access to steer a run.",
        "Sign in to steer a run.",
        "There is no such run here.",
        ...Object.values(SENTENCES),
      ])
        expect(text).not.toContain(sentence);
      expect(text).toContain("actions/steer_words.ts");
    });
  }
});
