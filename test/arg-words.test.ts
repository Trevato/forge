/**
 * An argument outside its allowed values is refused with one sentence, said
 * from src/core/arg_words.ts and read by every door (#5644). A copy typed
 * back into a door, or into the published contract, fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/core/arg_words.ts";

const ROOT = join(import.meta.dir, "..");
/** Three folders down: an MCP tool file or a contract route file. */
const DEEP = "../../../core/arg_words.ts";
/** Each file that refuses with these words, and how it imports them. */
const DOORS: Record<string, string> = {
  "src/http/api.ts": "../core/arg_words.ts",
  "src/http/api/upstream.ts": "../../core/arg_words.ts",
  "src/http/feed.ts": "../core/arg_words.ts",
  "src/http/mcp/tools/asked.ts": DEEP,
  "src/http/mcp/tools/board_pins.ts": DEEP,
  "src/http/mcp/tools/feed_chips.ts": DEEP,
  "src/http/mcp/tools/make_it_yours.ts": DEEP,
  "src/http/mcp/tools/repo_settings.ts": DEEP,
  "src/http/mcp/tools/signup.ts": DEEP,
  "src/http/mcp/tools/upstream.ts": DEEP,
  "src/http/mcp/tools/variant.ts": DEEP,
  "src/contract/openapi/routes/getApiV1Asked.ts": DEEP,
  "src/contract/openapi/routes/postApiV1ReposOwnerNameMakeItYours.ts": DEEP,
  "src/contract/openapi/routes/putApiV1ReposOwnerNameUpstream.ts": DEEP,
};

describe("an argument's allowed-values refusals", () => {
  test("the module says each sentence", () => {
    expect(Object.values(words).sort()).toEqual([
      "answer is like or dislike",
      "enabled is true or false",
      "hidden is true or false",
      "op must be pin, unpin or move",
      "order is oldest or newest",
      "signup is open, invite or closed",
      "visibility is public or private",
    ]);
  });

  for (const [door, from] of Object.entries(DOORS)) {
    test(`${door} reads them and types none of them out`, () => {
      const text = readFileSync(join(ROOT, door), "utf8");
      expect(text).toContain(`from "${from}"`);
      for (const sentence of Object.values(words)) {
        expect(text).not.toContain(sentence);
      }
    });
  }

  test("no other source file types one of them out", () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const copies: string[] = [];
    for (const file of glob.scanSync(ROOT)) {
      if (file === "src/core/arg_words.ts") continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const sentence of Object.values(words)) {
        if (text.includes(`"${sentence}"`) || text.includes(`"422: ${sentence}"`)) copies.push(`${file}: ${sentence}`);
      }
    }
    expect(copies).toEqual([]);
  });
});
