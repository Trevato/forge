/**
 * The forge's own briefs name paths in the forge's tree. AGENTS.md caps
 * README.md and puts a feature's how-to in docs/features/; the terminal is
 * src/tui/. The reviewer's "both doors" line used to ask for the README and
 * name `src/tty.ts`, so every pull collided on README.md. Another
 * repository — an app scaffolded with src/tty.ts and src/server.ts — keeps
 * its README line.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  systemPrompt,
  taskPrompt,
  type BriefInput,
  type TaskInput,
} from "../src/crew/brief.ts";

const ROOT = join(import.meta.dir, "..");

const base = (name: string) => ({
  agent: { user: { username: "bot", displayName: "" }, brief: "" },
  repo: { ownerName: "alice", name, defaultBranch: "main", autonomyDirection: "" },
  issue: { number: 7, title: "Widen", body: "", authorName: "alice" },
  branch: "bot/7",
  forgeUrl: "http://forge.test",
  isApp: true,
  comments: [],
  reviews: [],
  reviewDiff: "",
});

const review = (name: string, extra: object = {}): string =>
  taskPrompt({ ...base(name), reason: "review", design: true, ...extra } as unknown as TaskInput);

const doors = (prompt: string): string =>
  prompt.split("\n").find((l) => l.startsWith("- Both doors:")) ?? "";

describe("the reviewer's both-doors line", () => {
  test("for the forge, names src/tui/ and docs/features/, and not the README", () => {
    const line = doors(review("forge"));
    expect(line).toContain("`src/tui/`");
    expect(line).toContain("AGENTS.md");
    expect(line).toContain("`docs/features/<name>.md`");
    expect(line).toContain("README.md is capped: it is not where a feature's how-to goes");
    expect(line).not.toContain("src/tty.ts");
    expect(line).not.toContain("the README says how to use it");
  });

  test("for another repository, stays about its README", () => {
    const line = doors(review("notes"));
    expect(line).toBe(
      "- Both doors: what a person can do on the page they can do in `src/tty.ts` too, and the README says how to use it.",
    );
  });

  test("the security and test lines are unchanged for both", () => {
    for (const name of ["forge", "notes"]) {
      const out = review(name);
      expect(out).toContain(
        "- Tests: every behaviour the change adds has a test that would fail without it, and `bun test` is green in the diff.",
      );
      expect(out).toContain(
        "- Security: identity comes from the forge's signed headers and is verified, never trusted from a cookie,",
      );
    }
  });
});

describe("the app brief's security floor", () => {
  const sys = (name: string) => systemPrompt(base(name) as unknown as BriefInput);

  test("names the forge's floor for the forge and the scaffold's for an app", () => {
    expect(sys("forge")).toContain("`src/http/respond.ts` (`securityFloor`)");
    expect(sys("forge")).not.toContain("`src/server.ts`");
    expect(sys("notes")).toContain("the security floor in `src/server.ts` kept on every response");
  });
});

describe("every src/ path the forge's briefs name exists", () => {
  test("system, builder and reviewer briefs", () => {
    const forge = base("forge");
    const prompts = [
      systemPrompt(forge as unknown as BriefInput),
      systemPrompt({ ...forge, role: "planner" } as unknown as BriefInput),
      taskPrompt({ ...forge, reason: "assigned", issue: { ...forge.issue, title: "Expose pulls over MCP" } } as unknown as TaskInput),
      review("forge", { previewUrl: "http://preview.test" }),
    ];
    const paths = new Set(
      prompts.flatMap((p) =>
        [...p.matchAll(/`([^`]*)`/g)].flatMap((span) =>
          [...(span[1] ?? "").matchAll(/(?:^|[\s(])(src\/[\w./-]*)/g)].map((m) => m[1] ?? ""),
        ),
      ),
    );
    expect(paths.size).toBeGreaterThan(0);
    const missing = [...paths].filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
