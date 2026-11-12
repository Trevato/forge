/**
 * A cell inside a child forge is held under the child's own size: the child
 * is stopped as a whole when it and its cells pass its size, so a check
 * granted forge.json's 8 GiB in a large (8 GiB) child took the forge down
 * with it ("the forge kept going away under this check", grokbot-agency).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitWarnings, maxLimits, memoryCeiling, memoryCeilingSource, memorySource, OWN_SIZE_SHARE, resolveLimits } from "../src/apps/contain.ts";
import { SIZES } from "../src/spawn/sizes.ts";

const pod = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "mem-")), "memory.max");
  writeFileSync(f, text);
  return f;
};
const big = pod(String(64 * 1024 * 1048576));
const saved = { size: process.env["FORGE_CELL_SIZE"], mem: process.env["FORGE_CELL_MEMORY_MAX_MIB"] };

afterEach(() => {
  if (saved.size === undefined) delete process.env["FORGE_CELL_SIZE"];
  else process.env["FORGE_CELL_SIZE"] = saved.size;
  if (saved.mem === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved.mem;
});

describe("a child's cells fit inside the child", () => {
  test("the memory ceiling is a share of the child's size, under the machine's", () => {
    expect(memoryCeiling(undefined, big, "large")).toBe(Math.floor(SIZES.large.memoryMiB * OWN_SIZE_SHARE));
    expect(memoryCeiling(undefined, big, "small")).toBe(Math.floor(SIZES.small.memoryMiB * OWN_SIZE_SHARE));
    expect(memoryCeilingSource(undefined, big, "large")).toBe("size");
    // A machine smaller than the share still wins, and keeps its own name.
    expect(memoryCeiling("1024", big, "large")).toBe(1024);
    expect(memoryCeilingSource("1024", big, "large")).toBe("env");
    // No size: no child, the machine's ceiling as before.
    expect(memoryCeiling(undefined, big, undefined)).toBe(49152);
  });

  test("a check in a large child gets less than the child, not forge.json's 8 GiB", () => {
    delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
    process.env["FORGE_CELL_SIZE"] = "large";
    const l = resolveLimits("step", { memoryMiB: 8192, cpus: 16, diskMiB: 8192 }, big);
    expect(l.memoryMiB).toBeLessThan(SIZES.large.memoryMiB);
    expect(l.cpus).toBeLessThanOrEqual(SIZES.large.cpu);
    expect(l.diskMiB).toBeLessThan(SIZES.large.diskMiB);
    expect(memorySource(l.memorySource, l.ceilingFrom)).toContain("own size");
    expect(limitWarnings({ memoryMiB: 8192 }, big)[0]).toContain("own size");
  });

  test("a forge that is no child is unchanged", () => {
    delete process.env["FORGE_CELL_SIZE"];
    delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
    expect(resolveLimits("step", { memoryMiB: 8192 }, big).memoryMiB).toBe(8192);
    expect(maxLimits(big, undefined).memoryMiB).toBe(49152);
    process.env["FORGE_CELL_SIZE"] = "huge";
    expect(maxLimits(big).memoryMiB).toBe(49152);
  });
});
