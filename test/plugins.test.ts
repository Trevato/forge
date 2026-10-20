/** The thin plugins name only MCP tools the forge lists, so a rename there fails here. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolNames } from "../src/http/mcp.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Claude Code: the command text is the whole file after the front matter. */
const claudeText = (): string => read("plugins/claude-code/commands/forge.md").replace(/^---\n[\s\S]*?\n---\n/, "");

/** OpenCode: the COMMAND template literal, where backticks are escaped. */
const opencodeText = (): string => {
  const m = /const COMMAND = `([\s\S]*?[^\\])`;\n/.exec(read("plugins/opencode/forge.ts"));
  if (!m) throw new Error("plugins/opencode/forge.ts has no COMMAND template");
  return m[1]!.replaceAll("\\`", "`");
};

/** Backticked lowercase identifiers: tool names and argument names alike. */
const backticked = (text: string): string[] => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);

/** Backticked words that are the server or an argument, not a tool. */
const NOT_TOOLS = new Set(["forge", "repo", "text", "context", "page", "run", "commit", "said", "action", "ship", "close", "status"]);

/** Tools the command text tells the agent to call: every backticked name that is not an argument. */
const toolsNamed = (text: string): string[] => [...new Set(backticked(text))].filter((n) => !NOT_TOOLS.has(n));

const tools = new Set(toolNames());

for (const [label, text] of [
  ["plugins/claude-code/commands/forge.md", claudeText],
  ["plugins/opencode/forge.ts", opencodeText],
] as const) {
  test(`${label} names only tools the forge has`, () => {
    const named = toolsNamed(text());
    for (const core of ["tell", "now", "asks", "asks_act", "say"]) expect(named).toContain(core);
    expect(named.filter((n) => !tools.has(n))).toEqual([]);
  });
}

test("a renamed tool is caught", () => {
  expect(toolsNamed("call `tell_renamed` with `repo`").filter((n) => !tools.has(n))).toEqual(["tell_renamed"]);
  expect(backticked("`a_b` and `C`")).toEqual(["a_b"]);
});
