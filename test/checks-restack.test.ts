import { describe, expect, test } from "bun:test";
import { afterVerdicts, restack } from "../src/checks/restack.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("restack", () => {
  test("one pull is red alone", () => {
    const plan = restack([5]);
    expect(plan).toEqual({ kind: "alone", only: { pulls: [5], onto: "main" } });
    expect(afterVerdicts(plan, true, true)).toEqual({ land: [5], regate: [] });
    expect(afterVerdicts(plan, false, false)).toEqual({ land: [], regate: [], culprit: 5 });
  });

  test("two pulls: one on main, both stacked on it", () => {
    const plan = restack([1, 2]);
    expect(plan).toEqual({
      kind: "halves",
      first: { pulls: [1], onto: "main" },
      second: { pulls: [1, 2], onto: "first" },
    });
  });

  test("seven split 4 + 7, eight split 4 + 8", () => {
    for (const [n, h] of [[7, 4], [8, 4]] as const) {
      const plan = restack(ids(n));
      if (plan.kind !== "halves") throw new Error("expected halves");
      expect(plan.first.pulls).toEqual(ids(h));
      expect(plan.second.pulls).toEqual(ids(n));
      expect(plan.second.onto).toBe("first");
    }
  });

  test("empty batch is refused; input is not mutated", () => {
    expect(() => restack([])).toThrow();
    const input = [1, 2, 3];
    restack(input);
    expect(input).toEqual([1, 2, 3]);
  });

  test("every verdict pair", () => {
    const plan = restack(ids(7));
    expect(afterVerdicts(plan, true, true)).toEqual({ land: ids(7), regate: [] });
    expect(afterVerdicts(plan, true, false)).toEqual({ land: [1, 2, 3, 4], regate: [5, 6, 7] });
    expect(afterVerdicts(plan, false, true)).toEqual({ land: [], regate: [1, 2, 3, 4] });
    expect(afterVerdicts(plan, false, false)).toEqual({ land: [], regate: [1, 2, 3, 4] });
  });

  test("an 8-pull batch with one bad pull lands the 7 good ones, driven by the function alone", () => {
    for (let bad = 1; bad <= 8; bad++) {
      let batch = ids(8);
      let held: number[] = [];
      const landed: number[] = [];
      let rounds = 0;
      while (batch.length > 0 || held.length > 0) {
        if (batch.length === 0) {
          batch = held;
          held = [];
        }
        const plan = restack(batch);
        const green = (c: { pulls: number[] }) => !c.pulls.includes(bad);
        const out =
          plan.kind === "alone"
            ? afterVerdicts(plan, green(plan.only), green(plan.only))
            : afterVerdicts(plan, green(plan.first), green(plan.second));
        rounds++;
        landed.push(...out.land);
        const gone = new Set([...out.land, ...out.regate, ...(out.culprit ? [out.culprit] : [])]);
        held = [...batch.filter((p) => !gone.has(p)), ...held];
        batch = out.regate;
        expect(rounds).toBeLessThan(20);
      }
      expect(landed).toEqual(ids(8).filter((p) => p !== bad));
    }
  });

  test("with the bad pull last, the good 7 land across rounds that each land at least one", () => {
    let batch = ids(8);
    const landed: number[] = [];
    let rounds = 0;
    while (batch.length > 1) {
      const plan = restack(batch);
      if (plan.kind !== "halves") break;
      const out = afterVerdicts(plan, !plan.first.pulls.includes(8), !plan.second.pulls.includes(8));
      landed.push(...out.land);
      batch = out.regate;
      rounds++;
    }
    expect(landed).toEqual(ids(7));
    expect(rounds).toBe(3);
  });
});
