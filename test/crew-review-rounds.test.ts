import { describe, expect, test } from "bun:test";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";

const review = (authorName: string, commitOid: string) => ({
  id: "r1",
  authorId: "u1",
  authorName,
  originAuthor: null,
  state: "changes_requested",
  body: "fix it",
  commitOid,
  createdAt: "2026-10-01T00:00:00Z",
});

const prompt = (reviews: unknown[]) =>
  taskPrompt({
    reason: "review",
    agent: { user: { username: "rev", displayName: "" }, brief: "" },
    repo: { ownerName: "alice", name: "square", defaultBranch: "main", autonomyDirection: "" },
    issue: { number: 7, title: "t" },
    branch: "b",
    forgeUrl: "http://forge.test",
    isApp: false,
    comments: [],
    reviews,
    reviewComments: [],
    since: "",
  } as unknown as TaskInput);

describe("the reviewer's rounds", () => {
  test("a first review asks for every change at once", () => {
    const p = prompt([]);
    expect(p).toContain("list every change you need in it");
    expect(p).not.toContain("Non-blocking:");
  });

  test("a review by someone else is still a first round", () => {
    expect(prompt([review("alice", "abc")])).toContain("list every change you need in it");
  });

  test("a later round reads the diff since, answers each ask, and approves on non-blocking", () => {
    const p = prompt([review("rev", "0123456789abcdef")]);
    expect(p).not.toContain("list every change you need in it");
    expect(p).toContain("git diff 0123456789ab..HEAD");
    expect(p).toContain("Say for each earlier ask whether it is met");
    expect(p).toContain("new ask only on lines that changed");
    expect(p).toContain("`Non-blocking:`");
    expect(p).toContain("approve when only those remain");
  });
});
