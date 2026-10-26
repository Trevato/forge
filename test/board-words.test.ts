/**
 * A refused board save, vote or milestone watch is said from one place
 * (#5645): src/actions/board_words.ts. The API and the MCP import the
 * sentences; neither types one back.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOARD_NOT_SAVED,
  MILESTONE_WATCH_PERSON_ONLY,
  VOTE_NOT_RECORDED,
} from "../src/actions/board_words.ts";
import { importsFrom, mcpSource } from "./helpers/mcp.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string =>
  path === "src/http/mcp.ts" ? mcpSource(ROOT) : readFileSync(join(ROOT, path), "utf8");

const SENTENCES = {
  BOARD_NOT_SAVED: "that board could not be saved",
  VOTE_NOT_RECORDED: "that vote could not be recorded",
  MILESTONE_WATCH_PERSON_ONLY: "only a person watches a milestone",
} as const;

const FILES = ["src/http/api.ts", "src/http/mcp.ts"];

describe("board, vote and milestone-watch refusals", () => {
  test("the module says each sentence, word for word", () => {
    expect({ BOARD_NOT_SAVED, VOTE_NOT_RECORDED, MILESTONE_WATCH_PERSON_ONLY }).toEqual({ ...SENTENCES });
  });

  for (const file of FILES) {
    test(`${file} imports the sentences and types none of them`, () => {
      const text = read(file);
      expect(importsFrom(text, "actions/board_words.ts")).toBe(true);
      for (const [name, sentence] of Object.entries(SENTENCES)) {
        expect(text).not.toContain(sentence);
        expect(text).toContain(name);
      }
    });
  }
});
