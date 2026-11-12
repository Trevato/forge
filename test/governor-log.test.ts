import { describe, expect, test } from "bun:test";
import { governorSays, governorStep, type GovernorLast } from "../src/crew/governor_log.ts";

const at = (h: number, m: number) => Date.UTC(2026, 9, 26, h, m);
const base: GovernorLast = { from: 7, to: 7, why: "Builders 7: ok", at: at(9, 0) };

describe("governorStep", () => {
  test("the first reading is a baseline", () => {
    const r = governorStep(null, { slots: 7, why: "w" }, at(9, 0));
    expect(r.changed).toBe(false);
    expect(r.last.to).toBe(7);
    expect(governorSays(r.last)).toBe("");
  });
  test("lowering is remembered and worded", () => {
    const r = governorStep(base, { slots: 3, why: "9 opened vs 2 landed" }, at(20, 41));
    expect(r.changed).toBe(true);
    expect(r.last).toEqual({ from: 7, to: 3, why: "9 opened vs 2 landed", at: at(20, 41) });
    expect(governorSays(r.last)).toBe("Builders 7 → 3 at 20:41: 9 opened vs 2 landed");
  });
  test("the same count changes nothing", () => {
    const low = governorStep(base, { slots: 3, why: "a" }, at(20, 41)).last;
    const r = governorStep(low, { slots: 3, why: "b" }, at(21, 0));
    expect(r.changed).toBe(false);
    expect(r.last).toBe(low);
  });
  test("rising is remembered and worded", () => {
    const low = governorStep(base, { slots: 3, why: "a" }, at(20, 41)).last;
    const r = governorStep(low, { slots: 7, why: "Builders 7: fine" }, at(21, 30));
    expect(r.changed).toBe(true);
    expect(r.last.from).toBe(3);
    expect(governorSays(r.last)).toBe("Builders back to 7 at 21:30");
  });
  test("no last says nothing", () => {
    expect(governorSays(null)).toBe("");
  });
});

describe("the remembered last change", () => {
  const { Database } = require("bun:sqlite");
  const { default: sql } = require("../src/core/migrations/20261111160000-governor-last.ts");
  const { readLast, rememberGovernor } = require("../src/crew/governor_log.ts");
  const fresh = () => { const db = new Database(":memory:"); db.exec(sql); return db; };
  test("a baseline is stored but says nothing; a change is remembered and worded", () => {
    const db = fresh();
    expect(governorSays(rememberGovernor(db, "r", { slots: 6, why: "w" }, at(14, 0)))).toBe("");
    expect(readLast(db, "r")).toEqual({ from: 6, to: 6, why: "w", at: at(14, 0) });
    rememberGovernor(db, "r", { slots: 4, why: "9 opened vs 2 landed" }, at(14, 2));
    expect(governorSays(readLast(db, "r"))).toBe("Builders 6 → 4 at 14:02: 9 opened vs 2 landed");
  });
  test("a restart keeps it: the same file opened twice remembers the change", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "forge-gov-"));
    const file = join(dir, "x.db");
    try {
      const one = new Database(file);
      one.exec(sql);
      rememberGovernor(one, "r", { slots: 6, why: "w" }, at(14, 0));
      rememberGovernor(one, "r", { slots: 4, why: "x" }, at(14, 2));
      one.close();
      const two = new Database(file);
      rememberGovernor(two, "r", { slots: 4, why: "y" }, at(15, 0));
      expect(readLast(two, "r")?.at).toBe(at(14, 2));
      expect(governorSays(readLast(two, "r"))).toBe("Builders 6 → 4 at 14:02: x");
      two.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
