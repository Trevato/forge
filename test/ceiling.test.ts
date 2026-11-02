/** The forge's daily crew ceiling (#5798): reading the cap, reaching it, and which run carried spend across it. */

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ceilingHitAt, ceilingReached, forgeCeiling } from "../src/flow/ceiling.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");

describe("forgeCeiling", () => {
  test("reads a positive cap", () => {
    expect(forgeCeiling({ crewCeilingUsd: 25 })).toBe(25);
    expect(forgeCeiling({ crewCeilingUsd: 0.5 })).toBe(0.5);
  });
  test("0, negative, NaN and missing are no cap", () => {
    expect(forgeCeiling({ crewCeilingUsd: 0 })).toBeNull();
    expect(forgeCeiling({ crewCeilingUsd: -1 })).toBeNull();
    expect(forgeCeiling({ crewCeilingUsd: Number.NaN })).toBeNull();
    expect(forgeCeiling({})).toBeNull();
  });
});

describe("ceilingReached", () => {
  test("true at exactly the cap and over, false just under", () => {
    expect(ceilingReached(10, 10)).toBe(true);
    expect(ceilingReached(10.01, 10)).toBe(true);
    expect(ceilingReached(9.99, 10)).toBe(false);
  });
  test("false with no cap", () => {
    expect(ceilingReached(1e9, null)).toBe(false);
  });
});

describe("ceilingHitAt", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE run (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cost_usd REAL, created_at TEXT NOT NULL)");
  });
  let n = 0;
  const add = (kind: string, cost: number | null, at: string, id = `r${++n}`) =>
    db.run("INSERT INTO run (id, kind, cost_usd, created_at) VALUES (?, ?, ?, ?)", [id, kind, cost, at]);

  test("names the run whose cost carried the day across the cap", () => {
    add("agent", 4, "2026-10-27T01:00:00.000Z");
    add("agent", 4, "2026-10-27T02:00:00.000Z");
    add("agent", 4, "2026-10-27T03:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 10)).toBe("2026-10-27T03:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 8)).toBe("2026-10-27T02:00:00.000Z");
  });

  test("is null while under the cap, and with no cap", () => {
    add("agent", 4, "2026-10-27T01:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 4.01)).toBeNull();
    expect(ceilingHitAt(db, NOW, null)).toBeNull();
  });

  test("a run that lands exactly on the cap is the one", () => {
    add("agent", 4, "2026-10-27T01:00:00.000Z");
    add("agent", 6, "2026-10-27T02:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 10)).toBe("2026-10-27T02:00:00.000Z");
  });

  test("yesterday, non-agent runs and null costs do not count", () => {
    add("agent", 100, "2026-10-26T23:59:59.999Z");
    add("deploy", 100, "2026-10-27T00:30:00.000Z");
    add("check", 100, "2026-10-27T00:40:00.000Z");
    add("agent", null, "2026-10-27T01:00:00.000Z");
    add("agent", 3, "2026-10-27T02:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 5)).toBeNull();
    add("agent", 2, "2026-10-27T03:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 5)).toBe("2026-10-27T03:00:00.000Z");
  });

  test("runs are summed in time order, whatever order they were inserted", () => {
    add("agent", 6, "2026-10-27T05:00:00.000Z");
    add("agent", 6, "2026-10-27T01:00:00.000Z");
    expect(ceilingHitAt(db, NOW, 10)).toBe("2026-10-27T05:00:00.000Z");
  });

  test("two runs in the same millisecond both count, and a later run follows them", () => {
    const at = "2026-10-27T04:00:00.000Z";
    add("agent", 6, at, "z-first");
    add("agent", 6, at, "a-second");
    add("agent", 6, "2026-10-27T04:00:00.001Z", "later");
    expect(ceilingHitAt(db, NOW, 10)).toBe(at);
    expect(ceilingHitAt(db, NOW, 18)).toBe("2026-10-27T04:00:00.001Z");
  });
});
