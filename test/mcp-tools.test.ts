/**
 * One MCP tool per file (#5924): the contract every file under
 * src/http/mcp/tools/ keeps, and the generated index and docs table kept
 * current. A tool's own behaviour is tested in test/mcp-<name>.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexText, tableText, toolFiles, withTable } from "../scripts/mcp-tools.ts";
import { toolNames } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const files = toolFiles();

describe("every MCP tool file", () => {
  for (const name of files) {
    test(`${name}.ts exports one tool named ${name}`, async () => {
      const mod = await import(`../src/http/mcp/tools/${name}.ts`);
      expect(Object.keys(mod)).toEqual(["tool"]);
      const tool = mod.tool;
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.writes).toBe("boolean");
      expect(typeof tool.run).toBe("function");
      if (tool.doc !== undefined) {
        expect(tool.doc).not.toContain("\n");
        expect(tool.doc.trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe("the gathered tools", () => {
  test("are the files, sorted, one each, and `report` beside them", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(files);
    expect(files).not.toContain("report");
    expect(toolNames()).toEqual([...files, "report"]);
  });

  test("the index is current: run `bun scripts/mcp-tools.ts`", () => {
    expect(read("src/http/mcp/tools/index.ts")).toBe(indexText(files));
  });

  test("docs/MCP.md's tool table is current: run `bun scripts/mcp-tools.ts`", () => {
    const md = read("docs/MCP.md");
    expect(md).toBe(withTable(md, tableText(TOOLS)));
  });

  test("a new file is one new line in the index, touching no other", () => {
    const before = indexText(["a", "c"]).split("\n");
    const after = indexText(["a", "b", "c"]).split("\n");
    expect(after.filter((l) => !before.includes(l))).toEqual(['export { tool as b } from "./b.ts";']);
    expect(before.filter((l) => !after.includes(l))).toEqual([]);
  });
});
