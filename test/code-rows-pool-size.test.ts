import { expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { machineWorkers, poolSize } from "../src/web/code_rows_pool.ts";

test("unset, the pool is two workers whatever the machine", () => {
  expect(poolSize(undefined, 1)).toBe(2);
  expect(poolSize(undefined, 80)).toBe(2);
});

test("auto sizes from the machine: at least 2, at most 8", () => {
  expect(machineWorkers(1)).toBe(2);
  expect(machineWorkers(4)).toBe(4);
  expect(machineWorkers(80)).toBe(8);
  expect(poolSize("auto", 1)).toBe(2);
  expect(poolSize("auto", 6)).toBe(6);
  expect(poolSize(" auto ", 80)).toBe(8);
  expect(poolSize("auto")).toBe(Math.min(8, Math.max(2, availableParallelism())));
});

test("a number overrides, floored and capped at 8", () => {
  expect(poolSize("3", 80)).toBe(3);
  expect(poolSize("1", 80)).toBe(1);
  expect(poolSize("5.9", 2)).toBe(5);
  expect(poolSize("64", 2)).toBe(8);
});

test("a bad value falls back to the default of two", () => {
  for (const bad of ["", " ", "0", "-2", "0.5", "two", "NaN", "Infinity", "AUTO"]) {
    expect(poolSize(bad, 40)).toBe(2);
  }
});

test("FORGE_CODE_ROWS_WORKERS is what poolSize reads", () => {
  const was = process.env.FORGE_CODE_ROWS_WORKERS;
  try {
    process.env.FORGE_CODE_ROWS_WORKERS = "3";
    expect(poolSize()).toBe(3);
    process.env.FORGE_CODE_ROWS_WORKERS = "junk";
    expect(poolSize()).toBe(2);
    delete process.env.FORGE_CODE_ROWS_WORKERS;
    expect(poolSize()).toBe(2);
  } finally {
    if (was === undefined) delete process.env.FORGE_CODE_ROWS_WORKERS;
    else process.env.FORGE_CODE_ROWS_WORKERS = was;
  }
});
