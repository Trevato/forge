/**
 * An app note's sentences are said from one place (#5616): the files that
 * say them import them from `src/apps/note_words.ts`, and a copy typed back
 * into any of them fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTE_EMPTY, NOTE_FAILED, NOTE_TOO_LONG } from "../src/apps/note_words.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";

const root = join(import.meta.dir, "..");
const speakers = [
  "src/actions/app_notes.ts",
  "src/apps/toolbar.ts",
  "src/apps/feedback.ts",
  "src/tui/screens/report.ts",
  "src/web/studio/toolbar.ts",
];
const sentences = [NOTE_EMPTY, NOTE_FAILED, NOTE_TOO_LONG];

describe("an app note's sentences", () => {
  test("say what they said", () => {
    expect(sentences).toEqual([
      "Write a few words first.",
      "That did not go through. Try again.",
      "That is too long to send in one go.",
    ]);
  });

  for (const file of speakers) {
    test(`${file} imports them and types none of them out`, () => {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain("note_words.ts");
      for (const sentence of sentences) expect(text).not.toContain(sentence);
    });
  }

  test("the pill's script still carries them, as quoted strings", () => {
    expect(toolbarJs).toContain(JSON.stringify(NOTE_EMPTY));
    expect(toolbarJs).toContain(JSON.stringify(NOTE_FAILED));
  });
});
