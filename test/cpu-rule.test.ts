import { expect, test } from "bun:test";
import { CPU_STOP_GRACE_MS, CPU_STOP_HOLD_MS, cpuStop } from "../src/apps/cpu_rule.ts";

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
