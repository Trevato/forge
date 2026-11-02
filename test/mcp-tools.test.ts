/**
 * One MCP tool per file (#5924): the contract every file under
 * src/http/mcp/tools/ keeps, the generated index kept current, and the
 * live list in /llms.txt carrying every tool's `doc` (#8304), so no docs
 * file is regenerated when a tool changes. A tool's own behaviour is tested in test/mcp-<name>.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexText, toolFiles } from "../scripts/mcp-tools.ts";
import { REPORT_TOOL, toolNames } from "../src/http/mcp.ts";
import { byName } from "../src/http/mcp/shared.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { toolsSection } from "../src/web/llms_tools.ts";

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

  test("are ordered by code point, not the machine's locale", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect([{ name: "b" }, { name: "B" }, { name: "a" }].sort(byName).map((t) => t.name)).toEqual(["B", "a", "b"]);
  });

  test("a new file is one new line in the index, touching no other", () => {
    const before = indexText(["a", "c"]).split("\n");
    const after = indexText(["a", "b", "c"]).split("\n");
    expect(after.filter((l) => !before.includes(l))).toEqual(['export { tool as b } from "./b.ts";']);
    expect(before.filter((l) => !after.includes(l))).toEqual([]);
  });
});

describe("the live tool list", () => {
  test("every tool's `doc` is its line in /llms.txt's tools section", () => {
    const section = toolsSection([...TOOLS, REPORT_TOOL]);
    for (const t of [...TOOLS, REPORT_TOOL]) {
      const line = section.find((l) => l.startsWith(`- ${t.name}: `));
      expect([t.name, line?.includes(t.doc ?? t.description) ?? false]).toEqual([t.name, true]);
    }
    expect(section.filter((l) => l.startsWith("- ")).length).toBe(TOOLS.length + 1);
  });

  test("a pull adding a tool file and its index line needs no docs file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-mcp-tools-"));
    try {
      for (const n of files) await writeFile(join(dir, `${n}.ts`), "");
      await writeFile(join(dir, "zz_fixture.ts"), "");
      const names = toolFiles(dir);
      expect(names).toEqual([...files, "zz_fixture"]);
      // The index gains the one line, and the script writes nothing else.
      const added = indexText(names).split("\n").filter((l) => !indexText(files).split("\n").includes(l));
      expect(added).toEqual(['export { tool as zz_fixture } from "./zz_fixture.ts";']);
      expect(read("scripts/mcp-tools.ts").match(/writeFileSync\(\w+/g)).toEqual(["writeFileSync(INDEX"]);
      // Its `doc` reaches the live list with no committed file regenerated.
      const fixture = { name: "zz_fixture", doc: "`{}`: a fixture", description: "Fixture.", writes: false };
      expect(toolsSection([...TOOLS, fixture])).toContain("- zz_fixture: `{}`: a fixture");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
