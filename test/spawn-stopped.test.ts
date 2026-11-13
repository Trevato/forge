import { expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { backoffMs, cancelRestarts, clearStop, HOUR_MS, lastStop, noteStop, RESTART_MAX_MS, stopSentence, useRestart } from "../src/spawn/stopped.ts";

test("the wait doubles per stop and stops at the ceiling", () => {
  expect(backoffMs(1)).toBe(5_000);
  expect(backoffMs(2)).toBe(10_000);
  expect(backoffMs(30)).toBe(RESTART_MAX_MS);
});

test("a stop is restarted through the parent's own restarter, and the sentence says stopped, not restarted", async () => {
  const parent = {} as App;
  const other = {} as App;
  const restarted: string[] = [];
  let fired!: () => void;
  const done = new Promise<void>((r) => (fired = r));
  useRestart(parent, async (_p, name) => {
    restarted.push(name);
    fired();
    return true;
  });
  const at = Date.parse("2026-11-13T06:33:09Z");
  const stop = noteStop(parent, "b1", "probe", "used 2374 MiB of memory, over its 2048 MiB limit", at, 5);
  expect(lastStop(parent, "b1", at)).toEqual(stop);
  expect(lastStop(other, "b1", at)).toBeUndefined();
  expect(stopSentence(stop)).toBe("This forge ran out of memory and was stopped at 06:33 UTC; the host starts it again by itself.");
  await done;
  expect(restarted).toEqual(["probe"]);
  expect(noteStop(parent, "b1", "probe", "memory", at + 1000, 60_000).stops).toBe(2);
  expect(stopSentence(lastStop(parent, "b1", at + 1000)!)).toContain("stopped 2 times");
  cancelRestarts(parent);
  expect(lastStop(parent, "b1", at + 1000)).toBeUndefined();
});

test("a stop older than an hour is not shown, and stops older than an hour leave the count", () => {
  const parent = {} as App;
  const at = 1_000_000;
  noteStop(parent, "b", "k", "memory", at, 60_000);
  expect(lastStop(parent, "b", at + HOUR_MS - 1)).toBeDefined();
  expect(lastStop(parent, "b", at + HOUR_MS)).toBeUndefined();
  expect(noteStop(parent, "b", "k", "memory", at + HOUR_MS + 1, 60_000).stops).toBe(1);
  cancelRestarts(parent);
});

test("a restart that is skipped drops the stop; one that is coming keeps it", async () => {
  for (const coming of [false, true]) {
    const parent = {} as App;
    let fired!: () => void;
    const done = new Promise<void>((r) => (fired = r));
    useRestart(parent, async () => (fired(), coming));
    noteStop(parent, "b", "k", "memory", Date.now(), 1);
    await done;
    await new Promise((r) => setImmediate(r)); // let the restart's answer settle
    expect(lastStop(parent, "b") !== undefined).toBe(coming);
    cancelRestarts(parent);
  }
});

test("clearStop forgets the stop", () => {
  const parent = {} as App;
  noteStop(parent, "b", "k", "memory", Date.now(), 60_000);
  clearStop(parent, "b");
  expect(lastStop(parent, "b")).toBeUndefined();
  cancelRestarts(parent);
});
