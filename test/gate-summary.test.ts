/**
 * The block a timed full gate ends its log with (`scripts/gate-summary.ts`,
 * #2065): the cgroup is read or said unknown, a file over 45 s is named on
 * its own warning line, and fewer than ten files list what there is.
 */
import { describe, expect, test } from "bun:test";
import {
  SLOW_SECONDS,
  cgroupMemory,
  summaryLines,
  type GateSummary,
} from "../scripts/gate-summary.ts";

const GIB = 1024 ** 3;
const none = (): undefined => undefined;
const files = (map: Record<string, string>) => (path: string) => map[path];

const base: GateSummary = {
  shards: 12,
  cpus: 16,
  shardsMax: 32,
  files: 12,
  override: undefined,
  memoryBytes: 96 * GIB,
  workerBytes: 512 * 1024 ** 2,
  memory: { limit: undefined, peak: undefined },
  wallSeconds: 312.44,
  times: Array.from({ length: 12 }, (_, i) => ({
    file: `test/f${i}.test.ts`,
    seconds: i * 2,
  })),
};

describe("cgroupMemory", () => {
  test("no cgroup file: neither a limit nor a peak", () => {
    expect(cgroupMemory(none)).toEqual({ limit: undefined, peak: undefined });
  });

  test("cgroup v2: memory.max and memory.peak", () => {
    expect(
      cgroupMemory(
        files({
          "/sys/fs/cgroup/memory.max": "8589934592\n",
          "/sys/fs/cgroup/memory.peak": "6442450944\n",
        }),
      ),
    ).toEqual({
      limit: { bytes: 8 * GIB, from: "memory.max" },
      peak: { bytes: 6 * GIB, from: "memory.peak" },
    });
  });

  test("cgroup v1 falls back to max_usage_in_bytes; its 'unlimited' is no limit", () => {
    expect(
      cgroupMemory(
        files({
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
          "/sys/fs/cgroup/memory/memory.max_usage_in_bytes": "1073741824\n",
        }),
      ),
    ).toEqual({
      limit: undefined,
      peak: { bytes: GIB, from: "memory.max_usage_in_bytes" },
    });
  });

  test("v2 'max' is no limit, and junk is no number", () => {
    expect(
      cgroupMemory(
        files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.peak": "lots" }),
      ),
    ).toEqual({ limit: undefined, peak: undefined });
  });
});

describe("summaryLines", () => {
  test("no cgroup file: peak memory is unknown here, not a number", () => {
    const lines = summaryLines(base);
    expect(lines).toContain("test-shards: peak memory: unknown here");
    expect(lines).toContain(
      "test-shards: shards: 12 = least of 16 CPUs; 192 by memory, 96.00 GiB (no cgroup limit) at 512 MiB each; SHARDS_MAX 32; 12 files",
    );
  });

  test("the whole block, by hand: memory holds it under the CPUs, ten slowest of twelve", () => {
    // 4 GiB / 512 MiB = 8 workers, fewer than 16 CPUs, SHARDS_MAX 32 or 12 files.
    const lines = summaryLines({
      ...base,
      shards: 8,
      memoryBytes: 4 * GIB,
      memory: cgroupMemory(
        files({
          "/sys/fs/cgroup/memory.max": String(4 * GIB),
          "/sys/fs/cgroup/memory.peak": String(3.5 * GIB),
        }),
      ),
    });
    expect(lines).toEqual([
      "── gate summary",
      "test-shards: shards: 8 = least of 16 CPUs; 8 by memory, 4.00 GiB (cgroup memory.max) at 512 MiB each; SHARDS_MAX 32; 12 files — fewer than the CPUs because of memory",
      "test-shards: wall: 312.4s",
      "test-shards: peak memory: 3.50 GiB of 4.00 GiB (memory.peak)",
      "test-shards: slowest 10 of 12 files:",
      "    22.0s test/f11.test.ts",
      "    20.0s test/f10.test.ts",
      "    18.0s test/f9.test.ts",
      "    16.0s test/f8.test.ts",
      "    14.0s test/f7.test.ts",
      "    12.0s test/f6.test.ts",
      "    10.0s test/f5.test.ts",
      "     8.0s test/f4.test.ts",
      "     6.0s test/f3.test.ts",
      "     4.0s test/f2.test.ts",
    ]);
  });

  test("a file over 45 s is named on its own line; 45 s itself is not", () => {
    const lines = summaryLines({
      ...base,
      times: [
        { file: "test/ok.test.ts", seconds: SLOW_SECONDS },
        { file: "test/slow.test.ts", seconds: 52.06 },
        { file: "test/slower.test.ts", seconds: 197 },
      ],
    });
    const over = lines.filter((line) => line.startsWith("test-shards: over 45 s:"));
    expect(over).toEqual([
      "test-shards: over 45 s: test/slower.test.ts (197.0s)",
      "test-shards: over 45 s: test/slow.test.ts (52.1s)",
    ]);
  });

  test("fewer than ten files: every one is listed, and the heading says how many", () => {
    const lines = summaryLines({
      ...base,
      files: 2,
      shards: 2,
      times: [
        { file: "test/a.test.ts", seconds: 1.24 },
        { file: "test/b.test.ts", seconds: 3 },
      ],
    });
    expect(lines.slice(4)).toEqual([
      "test-shards: slowest 2 of 2 files:",
      "     3.0s test/b.test.ts",
      "     1.2s test/a.test.ts",
    ]);
  });

  test("FORGE_CHECK_SHARDS is named as the reason when it is set", () => {
    expect(summaryLines({ ...base, shards: 1, override: "1" })[1]).toBe(
      "test-shards: shards: 1 = least of FORGE_CHECK_SHARDS 1; 12 files",
    );
  });
});
