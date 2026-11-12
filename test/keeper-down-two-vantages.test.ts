/** Forge down (#7556): health failing twice from two vantage points is an event; one bad vantage is not. */
import { expect, test } from "bun:test";
import { vantagesFromEnv, type Vantage } from "../src/maintain/keeper/down.ts";
import { runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");
const kinds = (s: Awaited<ReturnType<typeof seed>>) =>
  s.db.query<{ kind: string }, []>("SELECT kind FROM event WHERE kind IN ('forge_down','forge_up') ORDER BY created_at, rowid").all().map((e) => e.kind);
const vantage = (name: string, up: { v: boolean }): Vantage => ({ name, ok: async () => up.v });

test("both vantages failing twice writes one forge_down; recovery writes forge_up", async () => {
  const s = await seed();
  const a = { v: false };
  const b = { v: false };
  const deps = { vantages: () => [vantage("home", a), vantage("far", b)] };
  await runKeeper(s, now, deps);
  expect(kinds(s)).toEqual([]);
  const out = await runKeeper(s, now, deps);
  expect(kinds(s)).toEqual(["forge_down"]);
  expect(out.actions[0]).toBe("forge down: health failed twice from home and far; alarm only");
  await runKeeper(s, now, deps);
  expect(kinds(s)).toEqual(["forge_down"]);
  a.v = true;
  b.v = true;
  await runKeeper(s, now, deps);
  expect(kinds(s)).toEqual(["forge_down", "forge_up"]);
});

test("one vantage failing is a bad network, not an outage", async () => {
  const s = await seed();
  const deps = { vantages: () => [vantage("home", { v: false }), vantage("far", { v: true })] };
  for (let i = 0; i < 4; i++) await runKeeper(s, now, deps);
  expect(kinds(s)).toEqual([]);
});

test("fewer than two vantages configured can confirm nothing", () => {
  expect(vantagesFromEnv("home=https://a.test/healthz")).toEqual([]);
  expect(vantagesFromEnv("")).toEqual([]);
  expect(vantagesFromEnv("a=https://a.test/h,b=ftp://x,c=https://c.test/h").map((v) => v.name)).toEqual(["a", "c"]);
});
