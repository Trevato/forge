import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/kernel/hash.ts";
import { planSpawn } from "../src/spawn/plan.ts";
import { parseSize, SIZES } from "../src/spawn/sizes.ts";

const source = { catalog: [], briefs: [], subscriptions: [] };
const base = { name: "kid", org: "kids", apps: [], carryBriefs: false, carrySubscriptions: false };

describe("sizes", () => {
  test("the table holds three sizes, each bigger than the last", () => {
    const [s, m, l] = [SIZES.small, SIZES.medium, SIZES.large];
    expect(s.cpu < m.cpu && m.cpu < l.cpu).toBe(true);
    expect(s.memoryMiB < m.memoryMiB && m.memoryMiB < l.memoryMiB).toBe(true);
    expect(s.diskMiB < m.diskMiB && m.diskMiB < l.diskMiB).toBe(true);
  });

  test("parseSize takes a size and refuses the rest in one sentence", () => {
    expect(parseSize("medium")).toEqual({ ok: true, value: "medium" });
    for (const bad of ["huge", "Small", "toString", "__proto__", 3, null, ""]) {
      const r = parseSize(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("size must be small, medium or large");
    }
  });

  test("a plan without a size hashes as it always did", () => {
    const r = planSpawn(base, source);
    if (!r.ok) throw new Error(r.error.reason);
    expect("size" in r.value).toBe(false);
    expect(sha256(JSON.stringify(r.value))).toBe(
      "8ae7676ae733670fbece93350800452b403c5373ec544f4c2c6104b17ca3767b",
    );
  });

  test("a chosen size is in the plan", () => {
    const r = planSpawn({ ...base, size: "large" }, source);
    if (!r.ok) throw new Error(r.error.reason);
    expect(r.value.size).toBe("large");
  });

  test("an unknown size is refused, after the other fields", () => {
    const r = planSpawn({ ...base, size: "huge" }, source);
    expect(r).toEqual({ ok: false, error: { field: "size", reason: "size must be small, medium or large" } });
    const first = planSpawn({ ...base, size: "huge", direction: 5 }, source);
    expect(first.ok === false && first.error.field).toBe("direction");
  });
});
