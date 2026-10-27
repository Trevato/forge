import { beforeEach, describe, expect, test } from "bun:test";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";
import { rememberPullFiles } from "../src/crew/hot_files.ts";
import { HOT_PULLS } from "../src/flow/hot_trend.ts";

const build = (role: "planner" | "builder", id = "repo-hot"): string =>
  taskPrompt({
    agent: { user: { username: "bot", displayName: "" }, brief: "" },
    repo: { id, ownerName: "alice", name: "forge", defaultBranch: "main" },
    issue: { number: 1, title: "Plan", body: "Direction", authorName: "alice" },
    comments: [],
    reviews: [],
    reason: "assigned",
    branch: "bot/1",
    forgeUrl: "http://forge.test",
    role,
  } as unknown as TaskInput);

const pulls = (files: string[], count: number) =>
  Array.from({ length: count }, (_, i) => ({ number: i + 1, files }));

describe("a planner's brief names the hot files", () => {
  beforeEach(() => rememberPullFiles("repo-hot", []));

  test("hottest first, a builder's brief without the line", () => {
    rememberPullFiles("repo-hot", [
      ...pulls(["src/a.ts"], HOT_PULLS),
      ...pulls(["src/b.ts"], HOT_PULLS + 1).map((p) => ({ ...p, number: p.number + 100 })),
    ]);
    const out = build("planner");
    expect(out).toContain(
      `Hot now (an issue whose Files: line names one waits): src/b.ts=${HOT_PULLS + 1} src/a.ts=${HOT_PULLS}`,
    );
    expect(build("builder")).not.toContain("Hot now");
  });

  test("at most ten files", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    rememberPullFiles("repo-hot", pulls(files, HOT_PULLS));
    const line = build("planner").split("\n").find((l) => l.startsWith("Hot now"))!;
    expect(line.match(/=/g)!.length).toBe(10);
  });

  test("no line when nothing is hot", () => {
    rememberPullFiles("repo-hot", pulls(["src/a.ts"], HOT_PULLS - 1));
    expect(build("planner")).not.toContain("Hot now");
  });
});
