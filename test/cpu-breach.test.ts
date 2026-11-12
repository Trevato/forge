/**
 * The line a cell is stopped with for CPU names the busiest process
 * (#11509), and only when one has spent any.
 */
import { describe, expect, test } from "bun:test";
import { busiest, cpuBreach, cpuSample } from "../src/apps/contain.ts";

describe("a cell stopped for CPU", () => {
  test("the busiest process is the one with the most ticks in the tree", () => {
    const ticks = new Map([[10, 50], [11, 4_000], [12, 300]]);
    expect(busiest([10, 11, 12], (pid) => ticks.get(pid) ?? 0)).toEqual({ pid: 11, ticks: 4_000 });
  });

  test("a tree where no process has spent a tick names none", () => {
    expect(busiest([10, 11], () => 0)).toBeUndefined();
    expect(busiest([], () => 5)).toBeUndefined();
  });

  test("the line: cores over the window against the limit, then the process and its CPU seconds", () => {
    // 9_300 ticks over 30 s at 100 ticks a second is 3.1 cores.
    const cores = 9_300 / 100 / 30;
    expect(cpuBreach(cores, 30.4, 1, { pid: 4242, ticks: 9_150, name: "chrome" })).toBe(
      "used 3.1 cores for 30s, over twice its limit of 1; the busiest process is chrome (pid 4242, 92s of CPU)",
    );
  });

  test("with no process to name, the line is the cores alone", () => {
    expect(cpuBreach(3.1, 30, 1, undefined)).toBe("used 3.1 cores for 30s, over twice its limit of 1");
  });

  test("the rule through the watch's state: 1.04 of 1 for an hour never stops", () => {
    const state = { samples: [], startedAt: 0, overSince: null as number | null };
    let ticks = 0;
    for (let t = 30_000; t <= 3_600_000; t += 30_000) {
      ticks += 104 * 30;
      expect(cpuSample(state, ticks, 1, t)).toBeNull();
    }
    expect(state.overSince).toBeNull();
  });

  test("2.5 of 1 for 6 minutes on a 15-minute-old cell stops once, naming the hold", () => {
    const state = { samples: [], startedAt: 0, overSince: null as number | null };
    const lines: string[] = [];
    let ticks = 0;
    for (let t = 15 * 60_000; t <= 21 * 60_000; t += 1_000) {
      if (t > 15 * 60_000) ticks += 250;
      const over = cpuSample(state, ticks, 1, t);
      if (over !== null) lines.push(cpuBreach(over.cores, over.seconds, 1, undefined));
      if (over !== null) break;
    }
    expect(lines).toEqual(["used 2.5 cores for 300s, over twice its limit of 1"]);
  });
});
