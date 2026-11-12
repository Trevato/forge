/** Lulls (#7556): two idle samples write one start event with its cause; the first busy one writes the end. */
import { expect, test } from "bun:test";
import type { Reading } from "../src/maintain/keeper/lull.ts";
import { ago, runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");
const events = (s: Awaited<ReturnType<typeof seed>>) =>
  s.db.query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'keeper_lull' ORDER BY created_at, rowid").all().map((e) => JSON.parse(e.payload));
const builders = (idle: boolean, cause = "ceiling reached"): Reading => ({ kind: "builders", idle, waiting: idle ? 3 : 0, cause });

test("a lull writes one start event with its cause and one end event", async () => {
  const s = await seed();
  const run = (idle: boolean) => runKeeper(s, now, { builders: () => builders(idle) });
  await run(true);
  expect(events(s)).toEqual([]);
  const second = await run(true);
  expect(events(s)).toEqual([{ lull: "builders", phase: "start", cause: "ceiling reached", waiting: 3 }]);
  expect(second.actions).toContain("builders lull began: ceiling reached");
  await run(true);
  expect(events(s).length).toBe(1);
  await run(false);
  expect(events(s).map((e) => e.phase)).toEqual(["start", "end"]);
  await run(false);
  expect(events(s).length).toBe(2);
});

test("nothing is written while nothing is startable, and one idle sample is no lull", async () => {
  const s = await seed();
  for (let i = 0; i < 4; i++) await runKeeper(s, now, { builders: () => builders(false) });
  expect(events(s)).toEqual([]);
  await runKeeper(s, now, { builders: () => builders(true) });
  await runKeeper(s, now, { builders: () => builders(false) });
  await runKeeper(s, now, { builders: () => builders(true) });
  expect(events(s)).toEqual([]);
});

test("checks idle while a pull waits for one is a lull of its own", async () => {
  const s = await seed();
  s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 5) });
  await runKeeper(s, now);
  await runKeeper(s, now);
  expect(events(s)).toEqual([{ lull: "checks", phase: "start", cause: "no check is queued or running", waiting: 1 }]);
});
