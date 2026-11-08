import { describe, expect, test } from "bun:test";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";

const build = (name: string): string =>
  taskPrompt({
    agent: { user: { username: "bot", displayName: "" }, brief: "" },
    repo: { ownerName: "alice", name, defaultBranch: "main" },
    issue: { number: 1, title: "Fix the footer", body: "It overlaps.", authorName: "alice" },
    comments: [],
    reviews: [],
    reason: "assigned",
    branch: "bot/1",
    forgeUrl: "http://forge.test",
  } as unknown as TaskInput);

describe("a forge task brief tells the agent to keep a plan", () => {
  test("the forge's own brief names keep_plan", () => {
    expect(build("forge")).toContain("`keep_plan`");
  });
  test("another repository's brief does not", () => {
    expect(build("notes")).not.toContain("keep_plan");
  });
});
