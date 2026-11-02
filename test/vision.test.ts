/**
 * docs/VISION.md is read by every run (#972): CLAUDE.md and the brief every
 * crew member gets point at it and state the rule that done means reachable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { systemPrompt } from "../src/crew/brief.ts";

const brief = (role: "planner" | "builder", isApp: boolean) =>
  systemPrompt({
    agent: { user: { username: "atlas", displayName: "Atlas" }, brief: "" },
    repo: { ownerName: "alice", name: "forge", defaultBranch: "main" },
    issue: { number: 1 },
    branch: "atlas/1-x",
    forgeUrl: "https://forge.example",
    isApp,
    resuming: false,
    role,
  } as unknown as Parameters<typeof systemPrompt>[0]);

describe("the vision", () => {
  test("the document exists and states the rule", () => {
    const text = readFileSync("docs/VISION.md", "utf8");
    expect(text.startsWith("# What the forge is for")).toBe(true);
    expect(text).toContain("Done means reachable");
  });

  test("CLAUDE.md sends the reader to it first", () => {
    const text = readFileSync("CLAUDE.md", "utf8");
    expect(text).toContain("Read docs/VISION.md first");
    expect(text).toContain("**Done means reachable**");
  });

  test("every role's brief says to read it", () => {
    for (const role of ["planner", "builder"] as const)
      for (const isApp of [false, true]) {
        const text = brief(role, isApp);
        expect(text).toContain("Read docs/VISION.md first");
        expect(text).toContain("Done means reachable");
        expect(text).toContain("docs/PRINCIPLES.md");
      }
  });
});
