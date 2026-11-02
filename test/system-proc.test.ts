import { describe, expect, test } from "bun:test";
import { parseLoad, parseMemory, parseProcStat } from "../src/system/proc";

const MEMINFO = `MemTotal:       16318412 kB
MemFree:         1234567 kB
MemAvailable:    9876543 kB
Buffers:          123456 kB
SwapTotal:       2097148 kB
SwapFree:        2097000 kB
`;

const stat = (comm: string, tail?: string[]) =>
  `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 3 0 ${tail ? tail.join(" ") : "987654 123456789 2500 18446744073709551615"} 1 1 0 0 0 0 0\n`;

describe("parseMemory", () => {
  test("real meminfo gives bytes", () => {
    expect(parseMemory(MEMINFO)).toEqual({
      total: 16318412 * 1024,
      available: 9876543 * 1024,
      swapTotal: 2097148 * 1024,
      swapFree: 2097000 * 1024,
    });
  });
  test("a machine without swap has zero swap, still a reading", () => {
    const m = parseMemory("MemTotal: 1000 kB\nMemAvailable: 500 kB\n");
    expect(m).toEqual({ total: 1024000, available: 512000, swapTotal: 0, swapFree: 0 });
  });
  test("no MemAvailable is unknown, not 0 bytes free", () => {
    expect(parseMemory(MEMINFO.replace(/MemAvailable:.*\n/, ""))).toBeNull();
  });
  test("empty, null, truncated and garbage give null", () => {
    for (const t of [null, "", "MemTotal:", "MemTotal:   163184", "MemTotal: abc kB\nMemAvailable: x kB", "\0\u{1F600}garbage\n"]) {
      expect(parseMemory(t)).toBeNull();
    }
  });
});

describe("parseLoad", () => {
  test("real loadavg", () => {
    expect(parseLoad("0.52 0.61 0.70 2/845 123456\n")).toEqual([0.52, 0.61, 0.7]);
  });
  test("empty, null, truncated and garbage give null, never NaN", () => {
    for (const t of [null, "", "  \n", "0.5", "0.5 0.6", "a b c", "0.5 NaN 0.7", "1 2 Infinity", "\0\0\0"]) {
      expect(parseLoad(t)).toBeNull();
    }
  });
});

describe("parseProcStat", () => {
  test("real stat line", () => {
    expect(parseProcStat(stat("bun"))).toEqual({ comm: "bun", ppid: 1, ticks: 200, rss: 2500 * 4096, start: 9876.54 });
  });
  test("comm with spaces and a )", () => {
    const s = parseProcStat(stat("my (odd) proc) x"));
    expect(s).toEqual({ comm: "my (odd) proc) x", ppid: 1, ticks: 200, rss: 2500 * 4096, start: 9876.54 });
  });
  test("a long comm is cut to 32", () => {
    expect(parseProcStat(stat("x".repeat(60)))?.comm).toHaveLength(32);
  });
  test("empty, truncated and garbage give null without throwing", () => {
    for (const t of ["", "4242", "4242 (bun", "4242 bun) S 1", "4242 (bun) S 1 4242", ")(", "garbage ) ( text", "\0\0"]) {
      expect(parseProcStat(t)).toBeNull();
    }
  });
  test("non-numeric fields become 0, never NaN", () => {
    const s = parseProcStat(`1 (a) S ${Array(30).fill("zz").join(" ")}`);
    expect(s).toEqual({ comm: "a", ppid: 0, ticks: 0, rss: 0, start: 0 });
  });
});
