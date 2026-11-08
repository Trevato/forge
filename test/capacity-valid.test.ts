import { describe, expect, test } from "bun:test";
import { CAPACITY, CAPACITY_KEYS, isCapacityKey, validCapacity } from "../src/core/capacity.ts";

describe("validCapacity: a setting takes only what its kind allows", () => {
  for (const key of CAPACITY_KEYS) {
    const kind = CAPACITY[key].kind;
    if (kind.type === "count") {
      test(`${key} takes ${kind.min}..${kind.max} and nothing near it`, () => {
        expect(validCapacity(key, String(kind.min))).toBe(true);
        expect(validCapacity(key, String(kind.max))).toBe(true);
        expect(validCapacity(key, String(kind.min - 1))).toBe(false);
        expect(validCapacity(key, String(kind.max + 1))).toBe(false);
        for (const bad of ["", "-1", "1.5", " 3", "3 ", "1e3", "0x10", "3\n"])
          expect(validCapacity(key, bad)).toBe(false);
      });
    } else {
      test(`${key} takes only ${kind.values.join(", ")}`, () => {
        for (const v of kind.values) {
          expect(validCapacity(key, v)).toBe(true);
          expect(validCapacity(key, v.toUpperCase())).toBe(false);
          expect(validCapacity(key, v[0]!.toUpperCase() + v.slice(1))).toBe(false);
          expect(validCapacity(key, ` ${v}`)).toBe(false);
        }
        for (const bad of ["", "maybe", "1", "true"]) expect(validCapacity(key, bad)).toBe(false);
      });
    }
  }
});

describe("isCapacityKey", () => {
  test("knows every key", () => {
    for (const key of CAPACITY_KEYS) expect(isCapacityKey(key)).toBe(true);
  });
  test("refuses an unknown key, the empty one and __proto__", () => {
    for (const bad of ["nope", "", "__proto__", "constructor", "toString", "Crew.concurrency"])
      expect(isCapacityKey(bad)).toBe(false);
  });
});
