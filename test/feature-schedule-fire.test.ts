/**
 * The forge calls an absorbed app's scheduled tool when it is due, once per
 * window, only while production runs, and remembers how it went. The clock is
 * injected; nothing waits on wall time.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { due, fireApp, fireDue, startFeatureSchedule, type Reach } from "../src/apps/feature_schedule.ts";
import { deleteApp } from "../src/core/apps.ts";
import { lastFires, recordFire } from "../src/core/feature_fires.ts";
import { absorb, unabsorb } from "../src/core/features.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { migrate } from "../src/kernel/migrate.ts";

const HOUR = 3_600_000;
const schedule = [{ tool: "scan", everyMs: HOUR }];
let db: Database;
let seen: string[];
let answer: () => Response;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    seen.push(new URL(req.url).pathname);
    return answer();
  },
});
const reach = (over: Partial<Reach> = {}): Reach => ({ port: () => server.port, declared: async () => ({ tools: ["scan"], schedule }), ...over });

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, migrationFiles);
  absorb(db, "a1", "admin", "Radar", "/");
  seen = [];
  answer = () => Response.json({ ok: true });
});
afterEach(() => db.close());

describe("due", () => {
  test("never fired is due; inside the interval is not; at it is", () => {
    expect(due(schedule, new Map(), 5)).toEqual(schedule);
    expect(due(schedule, new Map([["scan", 1000]]), 1000 + HOUR - 1)).toEqual([]);
    expect(due(schedule, new Map([["scan", 1000]]), 1000 + HOUR)).toEqual(schedule);
  });
});

describe("fireApp", () => {
  test("calls a due tool through /forge/tools and keeps how it went; two ticks in a window fire once", async () => {
    expect(await fireApp(db, "a1", reach(), () => 10_000)).toEqual(["scan"]);
    expect(seen).toEqual(["/forge/tools/scan"]);
    expect(await fireApp(db, "a1", reach(), () => 10_000 + HOUR - 1)).toEqual([]);
    expect(seen.length).toBe(1);
    expect(lastFires(db, "a1")).toEqual([{ tool: "scan", at: 10_000, ok: true, error: null, durationMs: 0 }]);
    expect(await fireApp(db, "a1", reach(), () => 10_000 + HOUR)).toEqual(["scan"]);
    expect(seen.length).toBe(2);
  });

  test("a failing tool is recorded with its sentence", async () => {
    answer = () => new Response("no", { status: 500 });
    await fireApp(db, "a1", reach(), () => 5);
    const [fire] = lastFires(db, "a1");
    expect(fire?.ok).toBe(false);
    expect(fire?.error).toBe("the app answered 500");
  });

  test("an asleep or stopped app is skipped and not called", async () => {
    expect(await fireApp(db, "a1", reach({ port: () => undefined }), () => 5)).toEqual([]);
    expect(seen).toEqual([]);
    expect(lastFires(db, "a1")).toEqual([]);
  });

  test("an un-absorbed app is never called", async () => {
    expect(await fireApp(db, "other", reach(), () => 5)).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a scheduled tool the app no longer declares is not called", async () => {
    const stale = reach({ declared: async () => ({ tools: ["other"], schedule }) });
    expect(await fireApp(db, "a1", stale, () => 5)).toEqual([]);
    expect(seen).toEqual([]);
    expect(lastFires(db, "a1")).toEqual([]);
  });
});

const addApp = (id: string, slug: string): void => {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'private')", [id, `repo-${id}`, slug]);
};

describe("what is kept", () => {
  const fire = { tool: "scan", at: 1, ok: true, error: null, durationMs: 2 };

  test("un-absorbing forgets the fires", () => {
    recordFire(db, "a1", fire);
    recordFire(db, "other", fire);
    expect(unabsorb(db, "a1")).toBe(true);
    expect(lastFires(db, "a1")).toEqual([]);
    expect(lastFires(db, "other")).toHaveLength(1);
  });

  test("deleting the app forgets the fires", () => {
    addApp("a1", "radar");
    recordFire(db, "a1", fire);
    expect(deleteApp(db, "a1")).toBe(true);
    expect(lastFires(db, "a1")).toEqual([]);
  });
});

describe("fireDue", () => {
  test("sweeps every app with the injected clock, once per window, and survives one that throws", async () => {
    addApp("a1", "radar");
    addApp("a2", "broken");
    absorb(db, "a2", "admin", "Broken", "/");
    const warned: string[] = [];
    const forge = { db, log: { warn: (m: string) => warned.push(m) } } as never;
    const reachOf = (r: { id: string }): Reach =>
      r.id === "a2" ? reach({ declared: async () => Promise.reject(new Error("boom")) }) : reach();
    await fireDue(forge, () => 10_000, reachOf);
    expect(seen).toEqual(["/forge/tools/scan"]);
    expect(warned).toEqual(["could not fire a scheduled tool"]);
    await fireDue(forge, () => 10_000 + HOUR - 1, reachOf);
    expect(seen.length).toBe(1);
    await fireDue(forge, () => 10_000 + HOUR, reachOf);
    expect(seen.length).toBe(2);
    expect(lastFires(db, "a1")[0]?.at).toBe(10_000 + HOUR);
  });
});

test("the timer does not start under the test harness", () => {
  expect(startFeatureSchedule({} as never)).toBeUndefined();
  server.stop(true);
});
