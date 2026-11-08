/**
 * A forge pull that touches src/web/ is reviewed against the principles that
 * open docs/DESIGN.md, a finding per principle broken, and the builder brief
 * points to the same lines (#9589). A pull that touches no UI is not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt, taskPrompt, type BriefInput, type TaskInput } from "../src/crew/brief.ts";
import {
  DESIGN_POINTER,
  DESIGN_PRINCIPLES,
  designPrinciples,
  loadDesignPrinciples,
} from "../src/crew/design_principles.ts";

const ROOT = join(import.meta.dir, "..");
const md = readFileSync(join(ROOT, "docs", "DESIGN.md"), "utf8");

const base = (name: string) => ({
  agent: { user: { username: "bot", displayName: "" }, brief: "" },
  repo: { ownerName: "trevato", name, defaultBranch: "main", autonomyDirection: "" },
  issue: { number: 7, title: "Widen", body: "", authorName: "trevato" },
  branch: "bot/7",
  forgeUrl: "http://forge.test",
  isApp: true,
  comments: [],
  reviews: [],
  reviewDiff: "",
});

const review = (design: boolean, name = "forge"): string =>
  taskPrompt({ ...base(name), reason: "review", design } as unknown as TaskInput);
const builder = (name = "forge"): string => systemPrompt(base(name) as unknown as BriefInput);

describe("the principles that open docs/DESIGN.md", () => {
  test("are read from the file, numbered, in order", () => {
    expect(DESIGN_PRINCIPLES.length).toBeGreaterThan(0);
    DESIGN_PRINCIPLES.forEach((p, i) => {
      expect(p.startsWith(`${i + 1}. `)).toBe(true);
      expect(md).toContain(p);
    });
  });

  test("are the list under the heading and nothing after it", () => {
    expect(designPrinciples("# T\n\n**The principles, in short.** x\n\n1. One.\n2. Two.\n\n- not this\n3. Nor this.")).toEqual([
      "1. One.",
      "2. Two.",
    ]);
    expect(designPrinciples("1. No heading.")).toEqual([]);
    expect(loadDesignPrinciples(join(ROOT, "no-such-file.md"))).toEqual([]);
  });
});

describe("a pull that touches src/web/", () => {
  test("the review brief carries every principle and asks a finding per one broken", () => {
    const out = review(true);
    for (const p of DESIGN_PRINCIPLES) expect(out).toContain(p);
    expect(out).toContain(DESIGN_POINTER);
    expect(out).toContain("for every principle the change breaks leave one finding");
  });

  test("the builder brief points to the same lines", () => {
    const out = builder();
    expect(out).toContain(DESIGN_POINTER);
    expect(md).toContain("**The principles, in short.**");
  });
});

describe("a pull that touches no UI", () => {
  test("the review brief carries none of them", () => {
    const out = review(false);
    for (const p of DESIGN_PRINCIPLES) expect(out).not.toContain(p);
    expect(out).not.toContain(DESIGN_POINTER);
  });
});

describe("another repository", () => {
  test("keeps its own docs/DESIGN.md: neither brief carries the forge's principles", () => {
    expect(review(true, "notes")).not.toContain(DESIGN_POINTER);
    expect(builder("notes")).not.toContain(DESIGN_POINTER);
  });
});
