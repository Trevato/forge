import { expect, test } from "bun:test";
import { expectedFiles } from "../src/crew/hot_files.ts";

test("a Files: line is the only list of expected files", () => {
  const body = "See src/actions/pulls.ts for context, and `README.md`.\n\nFiles: src/crew/hot_files.ts, `forge.json`\n\nAlso src/other/x.ts.";
  expect(expectedFiles({ title: "Touch docs/MCP.md", body })).toEqual(["src/crew/hot_files.ts", "forge.json"]);
});

test("without a Files: line every mentioned path counts", () => {
  const body = "See src/actions/pulls.ts and `README.md`.";
  expect(expectedFiles({ title: "Touch docs/MCP.md", body })).toEqual(["docs/MCP.md", "src/actions/pulls.ts", "README.md"]);
});

test("an empty Files: line expects nothing", () => {
  expect(expectedFiles({ title: "Touch docs/MCP.md", body: "See src/actions/pulls.ts.\nFiles:" })).toEqual([]);
});
