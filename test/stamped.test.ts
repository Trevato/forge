import { describe, expect, test } from "bun:test";
import { Stamped } from "../src/kernel/stamped.ts";

function memo(maxEntries = 3, maxAgeMs = 1000) {
  const clock = { t: 0 };
  const stamped = new Stamped<number>({ maxEntries, maxAgeMs, now: () => clock.t });
  let runs = 0;
  const compute = () => ++runs;
  return { clock, stamped, compute, runs: () => runs };
}

describe("Stamped", () => {
  test("same key and stamp computes once and counts the hits", () => {
    const m = memo();
    expect(m.stamped.get("a", "s1", m.compute)).toBe(1);
    expect(m.stamped.get("a", "s1", m.compute)).toBe(1);
    expect(m.stamped.get("a", "s1", m.compute)).toBe(1);
    expect(m.runs()).toBe(1);
    expect(m.stamped.hits).toBe(2);
    expect(m.stamped.misses).toBe(1);
    expect(m.stamped.size).toBe(1);
  });

  test("a new stamp recomputes and replaces the value", () => {
    const m = memo();
    expect(m.stamped.get("a", "s1", m.compute)).toBe(1);
    expect(m.stamped.get("a", "s2", m.compute)).toBe(2);
    expect(m.stamped.get("a", "s2", m.compute)).toBe(2);
    expect(m.stamped.size).toBe(1);
    expect(m.stamped.get("a", "s1", m.compute)).toBe(3);
  });

  test("the max age bound is strict", () => {
    const m = memo(3, 1000);
    m.stamped.get("a", "s", m.compute);
    m.clock.t = 999;
    expect(m.stamped.get("a", "s", m.compute)).toBe(1);
    m.clock.t = 1000;
    expect(m.stamped.get("a", "s", m.compute)).toBe(2);
    expect(m.stamped.size).toBe(1);
  });

  test("past maxEntries the least recently used key goes, not the least recently set", () => {
    const m = memo(2);
    m.stamped.get("a", "s", m.compute);
    m.stamped.get("b", "s", m.compute);
    m.stamped.get("a", "s", m.compute); // hit: a is now newest
    m.stamped.get("c", "s", m.compute); // evicts b
    expect(m.stamped.size).toBe(2);
    const before = m.runs();
    m.stamped.get("a", "s", m.compute);
    expect(m.runs()).toBe(before);
    m.stamped.get("b", "s", m.compute);
    expect(m.runs()).toBe(before + 1);
  });

  test("a compute that throws leaves no entry and the next read computes again", () => {
    const m = memo();
    expect(() => m.stamped.get("a", "s", () => { throw new Error("boom"); })).toThrow("boom");
    expect(m.stamped.size).toBe(0);
    expect(m.stamped.get("a", "s", m.compute)).toBe(1);
    expect(m.stamped.size).toBe(1);
  });

  test("a throwing recompute drops nothing it should keep and caches no failure", () => {
    const m = memo();
    m.stamped.get("a", "s1", m.compute);
    expect(() => m.stamped.get("a", "s2", () => { throw new Error("boom"); })).toThrow();
    expect(m.stamped.size).toBe(1);
    expect(m.stamped.get("a", "s2", m.compute)).toBe(2);
  });

  test("clear empties it", () => {
    const m = memo();
    m.stamped.get("a", "s", m.compute);
    m.stamped.get("b", "s", m.compute);
    expect(m.stamped.size).toBe(2);
    m.stamped.clear();
    expect(m.stamped.size).toBe(0);
    expect(m.stamped.get("a", "s", m.compute)).toBe(3);
  });

  test("peek returns an entry however old, and put stores one aged from now, counting nothing", () => {
    const m = memo(3, 1000);
    m.stamped.get("a", "s", m.compute);
    m.clock.t = 5000;
    expect(m.stamped.peek("a")).toEqual({ stamp: "s", value: 1, at: 0 });
    m.stamped.put("a", "s", 7);
    expect(m.stamped.peek("a")).toEqual({ stamp: "s", value: 7, at: 5000 });
    expect(m.stamped.get("a", "s", m.compute)).toBe(7);
    expect([m.stamped.hits, m.stamped.misses]).toEqual([1, 1]);
    expect(m.stamped.peek("b")).toBeUndefined();
  });
});
