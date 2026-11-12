/**
 * The line a cell is stopped with for CPU names the busiest process
 * (#11509), and only when one has spent any.
 */
import { describe, expect, test } from "bun:test";
import { busiest, cpuBreach } from "../src/apps/contain.ts";

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
      "used 3.1 cores for 30s, over its limit of 1; the busiest process is chrome (pid 4242, 92s of CPU)",
    );
  });

  test("with no process to name, the line is the cores alone", () => {
    expect(cpuBreach(3.1, 30, 1, undefined)).toBe("used 3.1 cores for 30s, over its limit of 1");
  });
});
