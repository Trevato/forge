/** A worker's walk of a directory counts the same bytes as the thread's. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBytes, diskBytesOff } from "../src/apps/contain.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-diskwalk-"));
  for (let d = 0; d < 5; d++) {
    mkdirSync(join(dir, `d${d}`, "deep"), { recursive: true });
    for (let f = 0; f < 20; f++) writeFileSync(join(dir, `d${d}`, "deep", `f${f}`), "x".repeat(f * 1000));
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the worker's walk equals the thread's, and a missing directory counts nothing", async () => {
  expect(diskBytes([dir])).toBeGreaterThan(100_000);
  expect(await diskBytesOff([dir])).toBe(diskBytes([dir]));
  expect(await diskBytesOff([join(dir, "nope")])).toBe(0);
});
