import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INVITE_NOT_OPEN, SEVER_CONFIRM } from "../src/actions/sever_invite_words.ts";

// Severing a fork and an invite link that is not open are said from one
// module; a copy typed back into a page or a screen fails here.
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const SAID_FROM_ONE_PLACE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [SEVER_CONFIRM, ["src/web/pages/chain.ts", "src/tui/screens/chain.ts"]],
  [INVITE_NOT_OPEN, ["src/web/pages/admin-limits.ts", "src/tui/screens/invites.ts"]],
];

describe("sever and invite words", () => {
  test("the module says each sentence as the doors always did", () => {
    expect(SEVER_CONFIRM).toBe("Type sever to confirm.");
    expect(INVITE_NOT_OPEN).toBe("That link is not open.");
  });

  for (const [sentence, files] of SAID_FROM_ONE_PLACE) {
    for (const file of files) {
      test(`${file} imports "${sentence}" rather than typing it`, () => {
        const text = read(file);
        expect(text).not.toContain(sentence);
        expect(text).toContain("actions/sever_invite_words.ts");
      });
    }
  }
});
