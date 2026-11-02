/**
 * The check on a push is the gate, so a crew run does not run it too: two
 * runs each running the whole sharded suite beside the check put a small
 * server at load 41. The brief and the repository's CLAUDE.md both say to
 * run the type check and the touched tests, never the whole gate.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt, type BriefInput } from "../src/crew/brief.ts";

describe("a crew run does not run the gate the check runs", () => {
  test("the brief asks for the type check and the touched tests, not the whole check", () => {
    const prompt = systemPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "bot/1",
      forgeUrl: "http://forge.test",
      isApp: false,
    } as unknown as BriefInput);
    expect(prompt).toContain("bun x tsc --noEmit");
    expect(prompt).toContain("&& bun test $files");
    expect(prompt).toContain("Not the whole suite");
    expect(prompt).not.toContain("Run the same command yourself");
  });

  test("the repository's own instructions name the files, and forbid the sharded gate", () => {
    const guide = readFileSync(join(import.meta.dir, "..", "CLAUDE.md"), "utf8");
    expect(guide).toContain("Never\n  `bun scripts/test-shards.ts --gate` inside a run");
    for (const file of [
      "test/reserved-names.test.ts",
      "test/studio.test.ts",
      "test/shards.test.ts",
      "test/check-list.test.ts",
      "test/hollow.test.ts",
    ])
      expect(guide).toContain(file);
  });
});
