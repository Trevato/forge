import { describe, expect, test } from "bun:test";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";

const build = (title: string, body: string, name = "forge"): string =>
  taskPrompt({
    agent: { user: { username: "bot", displayName: "" }, brief: "" },
    repo: { ownerName: "alice", name, defaultBranch: "main" },
    issue: { number: 1, title, body, authorName: "alice" },
    comments: [],
    reviews: [],
    reason: "assigned",
    branch: "bot/1",
    forgeUrl: "http://forge.test",
  } as unknown as TaskInput);

describe("an MCP issue is told about the tools/list budget", () => {
  test("named by path or by word, the brief says to run the size test", () => {
    for (const [t, b] of [
      ["Add a tool", "Edit src/http/mcp/tools.ts"],
      ["Expose pulls over MCP", "please"],
    ]) {
      const out = build(t!, b!);
      expect(out).toContain("bun test test/mcp-size.test.ts");
      expect(out).toContain("five costliest tools");
      expect(out).toContain("Room for a new tool");
      expect(out).toContain("never raise the ceilings");
    }
  });

  test("a plain issue's brief has none of it", () => {
    const out = build("Fix the footer", "The footer overlaps.");
    expect(out).not.toContain("mcp-size");
    expect(out).not.toContain("ceilings");
  });

  test("lowercase mcp does not trigger it", () => {
    expect(build("Fix the mcp client", "an mcp thing")).not.toContain("mcp-size");
  });

  test("another repository's MCP issue gets no rule", () => {
    const out = build("Expose pulls over MCP", "Edit src/http/mcp/tools.ts", "square");
    expect(out).not.toContain("mcp-size");
    expect(out).not.toContain("ceilings");
  });
});
