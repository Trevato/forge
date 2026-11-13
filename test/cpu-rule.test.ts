import { describe, expect, test } from "bun:test";
import { CPU_STOP_GRACE_MS, CPU_STOP_HOLD_MS, cpuStop, cpuWatch } from "../src/apps/cpu_rule.ts";
import { affinityArgv, cellArgv, cpuSample, type CpuState, WATCH } from "../src/apps/contain.ts";
import { enterArgv } from "../src/apps/cgroup.ts";

const M = 60_000;
const now = 100 * M;
const old = now - 20 * M;

test("at the limit is kept", () => {
  expect(cpuStop({ cores: 1, cpus: 1, overSinceMs: null, nowMs: now, startedAtMs: old })).toBe(false);
  expect(cpuStop({ cores: 1, cpus: 1, overSinceMs: now - 10 * M, nowMs: now, startedAtMs: old })).toBe(false);
});
test("1.9 of 1 for 10 minutes is kept", () => {
  expect(cpuStop({ cores: 1.9, cpus: 1, overSinceMs: now - 10 * M, nowMs: now, startedAtMs: old })).toBe(false);
});
test("2.1 of 1 for 4 minutes is kept", () => {
  expect(cpuStop({ cores: 2.1, cpus: 1, overSinceMs: now - 4 * M, nowMs: now, startedAtMs: old })).toBe(false);
});
test("2.1 of 1 for 5 minutes on a 20-minute-old cell is stopped", () => {
  expect(cpuStop({ cores: 2.1, cpus: 1, overSinceMs: now - CPU_STOP_HOLD_MS, nowMs: now, startedAtMs: old })).toBe(true);
});
test("3.0 of 1 at minute 9 of the cell's life is kept; at minute 10 it is stopped", () => {
  const s = now - 9 * M;
  expect(cpuStop({ cores: 3, cpus: 1, overSinceMs: s, nowMs: now, startedAtMs: s })).toBe(false);
  const t = now - CPU_STOP_GRACE_MS;
  expect(cpuStop({ cores: 3, cpus: 1, overSinceMs: t, nowMs: now, startedAtMs: t })).toBe(true);
});
test("an infinite cpus (kernel-capped) is kept", () => {
  expect(cpuStop({ cores: 50, cpus: Infinity, overSinceMs: now - 10 * M, nowMs: now, startedAtMs: old })).toBe(false);
});

/** Drive the watch's per-tick decision with a clock, as the cell watch does. */
function run(cores: number, cpus: number, forMs: number, startedAt = 0): { stoppedAt: number | null } {
  let over: number | null = null;
  for (let t = 0; t <= forMs; t += 1_000) {
    const v = cpuWatch(over, cores, cpus, startedAt + t, startedAt);
    over = v.overSinceMs;
    if (v.stop) return { stoppedAt: t };
  }
  return { stoppedAt: null };
}

test("the watch: a 1-CPU cell at 2.1 cores is not stopped after 31 s, or after 5 minutes (#11657)", () => {
  expect(run(2.1, 1, 31_000).stoppedAt).toBeNull();
  expect(run(2.1, 1, CPU_STOP_HOLD_MS - 1_000).stoppedAt).toBeNull();
});

test("the watch: 3.0 of 1 core held without a break is stopped at the hold, never before", () => {
  const { stoppedAt } = run(3, 1, 20 * M);
  expect(stoppedAt).toBe(Math.max(CPU_STOP_HOLD_MS, CPU_STOP_GRACE_MS));
});

test("the watch: a dip under the line resets the hold", () => {
  const a = cpuWatch(null, 3, 1, 1_000, 0);
  expect(a.overSinceMs).toBe(1_000);
  expect(cpuWatch(a.overSinceMs, 3, 1, 5_000, 0).overSinceMs).toBe(1_000);
  expect(cpuWatch(a.overSinceMs, 1.5, 1, 6_000, 0)).toEqual({ overSinceMs: null, stop: false });
});

const limits = (cpus: number) => ({ memoryMiB: 1, cpus, diskMiB: 1 });

test("a cell the kernel does not hold is pinned to its cores; one it holds, or the whole machine, is not (#11657)", () => {
  const spec = { cpuQuota: true, limits: limits(1) };
  const rotor = () => ({ next: 0 });
  expect(affinityArgv(spec, false, rotor(), 4, true)).toEqual(["taskset", "-c", "0"]);
  expect(affinityArgv(spec, true, rotor(), 4, true)).toEqual([]);
  expect(affinityArgv(spec, false, rotor(), 4, false)).toEqual([]);
  expect(affinityArgv(spec, false, rotor(), 1, true)).toEqual([]);
  expect(affinityArgv({ cpuQuota: false, limits: limits(1) }, false, rotor(), 4, true)).toEqual([]);
});

test("pinned cells rotate over the cores, wrapping past the last", () => {
  const spec = { cpuQuota: true, limits: limits(2) };
  const rotor = { next: 0 };
  const cores = Array.from({ length: 3 }, () => affinityArgv(spec, false, rotor, 4, true)[2]);
  expect(cores).toEqual(["0,1", "2,3", "0,1"]);
  // A 1.5-cpu cell takes two whole cores; one from 3 of 4 wraps to core 0.
  expect(affinityArgv({ cpuQuota: true, limits: limits(1.5) }, false, { next: 3 }, 4, true)[2]).toBe("3,0");
});

describe("the argv openCell runs a command as (cellArgv)", () => {
  const bwrap = ["bwrap", "--", "true"];
  const spec = { cpuQuota: true, limits: limits(1) };

  test("no cgroup the kernel caps: the command is pinned inside the cgroup's enter", () => {
    const argv = cellArgv(bwrap, spec, { dir: "/sys/fs/cgroup/cell-a", cpuCapped: false }, { next: 2 }, 4, true);
    expect(argv).toEqual(enterArgv("/sys/fs/cgroup/cell-a/cgroup.procs", ["taskset", "-c", "2", ...bwrap]));
  });

  test("a cgroup that caps the cores: entered, not pinned", () => {
    const argv = cellArgv(bwrap, spec, { dir: "/sys/fs/cgroup/cell-b", cpuCapped: true }, { next: 0 }, 4, true);
    expect(argv).toEqual(enterArgv("/sys/fs/cgroup/cell-b/cgroup.procs", bwrap));
  });

  test("no cgroup at all: pinned, then bwrap", () => {
    expect(cellArgv(bwrap, spec, undefined, { next: 0 }, 4, true)).toEqual(["taskset", "-c", "0", ...bwrap]);
    expect(cellArgv(bwrap, spec, undefined, { next: 0 }, 4, false)).toEqual(bwrap);
  });
});

describe("the watch's tick feeds the rule (cpuSample)", () => {
  const CLK_TCK = 100;

  /** A tree burning `cores` from t = 0, sampled each second; the second at which it is stopped, or null. */
  function watch(cores: number, cpus: number, forMs: number): { stoppedAt: number | null; state: CpuState } {
    const state: CpuState = { samples: [], startedAt: 0, overSince: null };
    for (let t = 0; t <= forMs; t += 1_000) {
      const over = cpuSample(state, Math.round((cores * CLK_TCK * t) / 1000), cpus, t);
      if (over !== null) {
        expect(over.cores).toBeCloseTo(cores, 5);
        // Held from the first full window (30 s) to the stop: the hold, not the window.
        expect(over.seconds).toBe((t - WATCH.cpuWindowMs) / 1000);
        return { stoppedAt: t, state };
      }
    }
    return { stoppedAt: null, state };
  }

  test("a 1-CPU forge at 2.1 cores is not stopped at 31 s — the old 1.5× line would have (#11657)", () => {
    const { stoppedAt, state } = watch(2.1, 1, 31_000);
    expect(stoppedAt).toBeNull();
    // The window filled at 30 s, and from then the hold is kept on the watched cell.
    expect(state.overSince).toBe(WATCH.cpuWindowMs);
  });

  test("2.1 of 1 core held is stopped once the grace is over, not before", () => {
    expect(watch(2.1, 1, CPU_STOP_GRACE_MS - 1_000).stoppedAt).toBeNull();
    expect(watch(2.1, 1, 20 * M).stoppedAt).toBe(CPU_STOP_GRACE_MS);
  });

  test("at twice its cores, not over: never stopped, and no hold kept", () => {
    const { stoppedAt, state } = watch(2, 1, 20 * M);
    expect(stoppedAt).toBeNull();
    expect(state.overSince).toBeNull();
  });

  test("a dip under the line inside the window restarts the hold", () => {
    const state: CpuState = { samples: [], startedAt: -CPU_STOP_GRACE_MS, overSince: null };
    let ticks = 0;
    let stoppedAt: number | null = null;
    for (let t = 0; t <= 20 * M && stoppedAt === null; t += 1_000) {
      // Busy at 3 cores, idle for one window at 4 minutes.
      const idle = t > 4 * M && t <= 4 * M + WATCH.cpuWindowMs;
      if (t > 0) ticks += idle ? 0 : 3 * CLK_TCK;
      if (cpuSample(state, ticks, 1, t) !== null) stoppedAt = t;
    }
    // Over again from the first full busy window after the dip; stopped a hold later.
    expect(stoppedAt).toBeGreaterThan(4 * M + CPU_STOP_HOLD_MS);
    expect(stoppedAt).toBeLessThanOrEqual(4 * M + 2 * WATCH.cpuWindowMs + CPU_STOP_HOLD_MS);
  });
});
