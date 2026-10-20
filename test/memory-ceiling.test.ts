/** The memory ceiling follows the host and a declared limit above it is said aloud (#3128). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitWarnings, memoryCeiling, memorySource, resolveLimits } from "../src/apps/contain.ts";

const pod = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "mem-")), "memory.max");
  writeFileSync(f, text);
  return f;
};

describe("the memory ceiling is never a silent clamp (#3128)", () => {
  test("the env wins; else a share of the pod's memory.max; else 4096", () => {
    expect(memoryCeiling("8192", pod("1073741824"))).toBe(8192);
    expect(memoryCeiling(undefined, pod(String(16384 * 1048576)))).toBe(12288);
    expect(memoryCeiling(undefined, pod("max\n"))).toBe(4096);
    expect(memoryCeiling(undefined, "/nonexistent/memory.max")).toBe(4096);
  });

  test("a declared memory above the ceiling produces a warning; within it, none", () => {
    const saved = process.env["FORGE_CELL_MEMORY_MAX_MIB"];
    process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
    try {
      const lines = limitWarnings({ memoryMiB: 8192 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("declares memory 8192 MiB");
      expect(lines[0]).toContain("FORGE_CELL_MEMORY_MAX_MIB");
      expect(limitWarnings({ memoryMiB: 2048 })).toEqual([]);
      expect(limitWarnings(undefined)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
      else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved;
    }
  });

  test("the kill message names the limit's real source, even when forge.json declares exactly the ceiling", () => {
    const saved = process.env["FORGE_CELL_MEMORY_MAX_MIB"];
    process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
    try {
      const source = (declared?: { memoryMiB: number }) =>
        memorySource(resolveLimits("step", declared).memorySource);
      expect(source({ memoryMiB: 8192 })).toContain("FORGE_CELL_MEMORY_MAX_MIB");
      expect(source({ memoryMiB: 4096 })).toBe("forge.json limits.memory");
      expect(source({ memoryMiB: 1024 })).toBe("forge.json limits.memory");
      expect(source()).toBe("the default");
      expect(limitWarnings({ memoryMiB: 4096 })).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
      else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved;
    }
  });
});
