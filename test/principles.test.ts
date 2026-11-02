/**
 * docs/PRINCIPLES.md is short on purpose (#7641): a hard cap, so adding a
 * principle means removing or absorbing one. Each names what enforces it, or
 * says nothing does yet, and the crew's briefs read it rather than repeat it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt, type BriefInput } from "../src/crew/brief.ts";
import { CONVERSATION_BRIEF, conversationBrief } from "../src/crew/conversation_brief.ts";
import { loadPrinciples, principleLines } from "../src/crew/principles.ts";

const ROOT = join(import.meta.dir, "..");
const md = readFileSync(join(ROOT, "docs", "PRINCIPLES.md"), "utf8");
const bullets = md.split("\n").filter((l) => l.startsWith("- "));

describe("docs/PRINCIPLES.md", () => {
  test("stays under its cap of 10 principles and 2500 bytes", () => {
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(2500);
  });

  test("each principle names what enforces it, or says nothing does yet", () => {
    for (const b of bullets) expect(b).toMatch(/ Enforced by: .+/);
  });

  test("each file an enforcer names exists", () => {
    for (const b of bullets) {
      const named = [...b.slice(b.indexOf("Enforced by:")).matchAll(/`((?:src|test|scripts)\/[^`]+)`/g)].map((m) => m[1]!);
      for (const path of named) expect(existsSync(join(ROOT, path))).toBe(true);
    }
  });
});

describe("who reads it", () => {
  test("principleLines drops the markdown and the enforcer", () => {
    expect(principleLines("# T\n- **A rule.** Why. Enforced by: `x.ts`.\nprose")).toEqual(["A rule. Why."]);
  });

  test("the in-forge conversation is briefed with every principle", () => {
    for (const line of principleLines(md)) expect(CONVERSATION_BRIEF).toContain(line);
  });

  test("a missing file gives no principles, and the brief then has no section", () => {
    expect(loadPrinciples(join(ROOT, "docs", "NO-SUCH-FILE.md"))).toEqual([]);
    expect(conversationBrief([])).not.toContain("What the forge holds to");
    expect(conversationBrief(["One."])).toContain("What the forge holds to: One.");
  });

  test("the image copies the file the agents are briefed from", () => {
    expect(readFileSync(join(ROOT, "Dockerfile"), "utf8")).toMatch(/^COPY docs\/PRINCIPLES\.md \.\/docs\/PRINCIPLES\.md$/m);
  });

  test("a crew run is pointed at the file, and still told the rule an app repository has no file for", () => {
    const prompt = systemPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "bot/1",
      forgeUrl: "http://forge.test",
      isApp: false,
    } as unknown as BriefInput);
    expect(prompt).toContain("docs/PRINCIPLES.md");
    expect(prompt).toContain("Done means reachable");
  });

  const builder = systemPrompt({
    agent: { user: { username: "bot", displayName: "" }, brief: "" },
    repo: { ownerName: "a", name: "forge", defaultBranch: "main" },
    issue: { number: 1 },
    branch: "b",
    forgeUrl: "http://f",
    isApp: true,
  } as unknown as BriefInput);

  test("the builder brief is at least 100 bytes shorter than on main before #8737 (7303 bytes, an app on the forge)", () => {
    expect(Buffer.byteLength(builder)).toBeLessThanOrEqual(7303 - 100);
  });

  test("the brief points at the file, and no longer spells out the two taps", () => {
    expect(builder).toContain("docs/PRINCIPLES.md");
    expect(builder).not.toContain("two taps");
  });
});
