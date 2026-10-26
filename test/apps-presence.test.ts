/**
 * Who else serves this data's apps (#4496, `apps/presence.ts`): a forge
 * still beating is there, one that stopped or went silent is not, and only
 * behind one that is there does readiness wait.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { alive, STALE_MS, takePresence, warmBehind } from "../src/apps/presence.ts";
import { health, readyResponse } from "../src/http/health.ts";
import { createLog } from "../src/kernel/log.ts";

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "forge-presence-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  health.starting = undefined;
  health.startingSince = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the first forge on its data sees nobody, and is ready while its apps start", () => {
  const first = takePresence(fresh());
  expect(first.others()).toBe(false);
  warmBehind(createLog("test"), first, () => 3);
  expect(readyResponse().status).toBe(200);
  first.stop();
});

test("a forge beside one still serving waits for its apps; once the old one stops, it waits no more", () => {
  const dataDir = fresh();
  const old = takePresence(dataDir);
  const next = takePresence(dataDir);
  expect(next.others()).toBe(true);
  warmBehind(createLog("test"), next, () => 1);
  expect(readyResponse().status).toBe(503);
  old.stop();
  expect(next.others()).toBe(false);
  expect(readyResponse().status).toBe(200);
  next.stop();
});

test("a beat older than three missed beats is a forge that died", () => {
  const beat = { id: "00000000-0000-4000-8000-000000000000", host: "elsewhere", pid: 1, at: 1_000_000 };
  expect(alive(beat, 1_000_000 + STALE_MS - 1, "here")).toBe(true);
  expect(alive(beat, 1_000_000 + STALE_MS, "here")).toBe(false);
});

test("on this host a fresh beat from a pid that no longer runs is a crash, not a predecessor", () => {
  const dataDir = fresh();
  const dead = Bun.spawnSync(["true"]).pid;
  const beat = { id: "11111111-1111-4111-8111-111111111111", host: hostname(), pid: dead, at: Date.now() };
  expect(alive(beat, Date.now())).toBe(false);
  const next = takePresence(dataDir);
  writeFileSync(join(dataDir, "serving", `${beat.id}.json`), JSON.stringify(beat));
  expect(next.others()).toBe(false);
  writeFileSync(join(dataDir, "serving", `${beat.id}.json`), JSON.stringify({ ...beat, pid: process.pid }));
  expect(next.others()).toBe(true);
  next.stop();
});

test("a torn or foreign file in the directory says nobody is there", () => {
  const dataDir = fresh();
  const next = takePresence(dataDir);
  writeFileSync(join(dataDir, "serving", "junk.json"), "{not json");
  writeFileSync(join(dataDir, "serving", "other.json"), JSON.stringify({ id: "../x", host: "h", pid: 1, at: Date.now() }));
  expect(next.others()).toBe(false);
  next.stop();
});
