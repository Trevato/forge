/**
 * The forge pulls a running adapter on its schedule (#10043): a due adapter
 * is pulled once, one not yet due is not, a sleeping app is never reached, a
 * failing answer is recorded failed, and two pulls of one app never overlap.
 * The clock and the reach are fakes; one test posts to a loopback server to
 * prove the real request's path, size cap and shape.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PULL_BODY_MAX } from "../src/apps/pull.ts";
import {
  isPullDue,
  postPull,
  pullApp,
  pullDue,
  startPullSchedule,
  type PullReach,
  type PullReply,
} from "../src/apps/pull_schedule.ts";
import { listPullRuns } from "../src/core/runs.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { migrate } from "../src/kernel/migrate.ts";

const EVERY = 900; // seconds
const good = JSON.stringify({ pulled: 4, skipped: 1, cursor: "c1", errors: 0 });

let db: Database;
let posts: number;
let reply: () => Promise<PullReply>;

const reach = (over: Partial<PullReach> = {}): PullReach => ({
  port: () => 4321,
  adapter: async () => ({ schedule: { every: EVERY } }),
  post: async () => {
    posts += 1;
    return reply();
  },
  ...over,
});

/** A pull recorded `agoMs` before the real clock, so "last pull" is under the test's control. */
const pulledAgo = (appId: string, agoMs: number): void => {
  db.run(
    `INSERT INTO pull_run (id, app_id, state, cursor, created_at) VALUES (?1, ?2, 'ok', 'c0', ?3)`,
    ["00000000000000000000000000", appId, new Date(Date.now() - agoMs).toISOString()],
  );
};

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, migrationFiles);
  posts = 0;
  reply = async () => ({ status: 200, body: good });
});
afterEach(() => db.close());

describe("isPullDue", () => {
  test("never pulled is due; inside the interval is not; at it is", () => {
    expect(isPullDue(undefined, EVERY, 5)).toBe(true);
    expect(isPullDue(1000, EVERY, 1000 + EVERY * 1000 - 1)).toBe(false);
    expect(isPullDue(1000, EVERY, 1000 + EVERY * 1000)).toBe(true);
  });
});

describe("pullApp", () => {
  test("a due adapter is pulled once and its answer recorded; the next tick inside the interval does nothing", async () => {
    let t = Date.now();
    const clock = () => t;
    expect(await pullApp(db, "a1", reach(), clock)).toBe(true);
    expect(posts).toBe(1);
    const [run] = listPullRuns(db, "a1");
    expect(run).toMatchObject({ state: "ok", written: 4, skipped: 1, cursor: "c1", failed: 0 });
    t += 60_000; // one tick later: not due
    expect(await pullApp(db, "a1", reach(), clock)).toBe(false);
    expect(posts).toBe(1);
    t += EVERY * 1000; // a whole interval later: due again
    expect(await pullApp(db, "a1", reach(), clock)).toBe(true);
    expect(posts).toBe(2);
  });

  test("an adapter pulled less than `every` seconds ago is not pulled", async () => {
    pulledAgo("a1", (EVERY - 1) * 1000);
    expect(await pullApp(db, "a1", reach())).toBe(false);
    expect(posts).toBe(0);
    expect(listPullRuns(db, "a1")).toHaveLength(1);
  });

  test("a failing answer is recorded as failed with its reason", async () => {
    reply = async () => ({ status: 500, body: "no" });
    expect(await pullApp(db, "a1", reach())).toBe(true);
    const [run] = listPullRuns(db, "a1");
    expect(run?.state).toBe("failed");
    expect(run?.reason).toBe("status 500 is not 2xx");
  });

  test("no answer at all is recorded as failed", async () => {
    reply = async () => ({ error: "the app did not answer" });
    await pullApp(db, "a1", reach());
    expect(listPullRuns(db, "a1")[0]).toMatchObject({ state: "failed", reason: "the app did not answer" });
  });

  test("a sleeping app is never reached, and its manifest is not read", async () => {
    let read = false;
    const asleep = reach({ port: () => undefined, adapter: async () => ((read = true), { schedule: { every: EVERY } }) });
    expect(await pullApp(db, "a1", asleep)).toBe(false);
    expect(posts).toBe(0);
    expect(read).toBe(false);
    expect(listPullRuns(db, "a1")).toEqual([]);
  });

  test("an app without an adapter block is not pulled", async () => {
    expect(await pullApp(db, "a1", reach({ adapter: async () => undefined }))).toBe(false);
    expect(posts).toBe(0);
  });

  test("a second pull of the same app while one is in flight does not overlap it", async () => {
    let release!: () => void;
    reply = () => new Promise((resolve) => (release = () => resolve({ status: 200, body: good })));
    const first = pullApp(db, "a1", reach());
    await Bun.sleep(0);
    expect(await pullApp(db, "a1", reach())).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(posts).toBe(1);
    expect(listPullRuns(db, "a1")).toHaveLength(1);
  });
});

describe("pullDue", () => {
  test("sweeps every app: the due one pulled once, the one not due left, one that throws logged", async () => {
    db.run("PRAGMA foreign_keys = OFF");
    for (const [id, slug] of [["a1", "due"], ["a2", "fresh"], ["a3", "broken"]] as const)
      db.run("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'private')", [id, `repo-${id}`, slug]);
    pulledAgo("a2", 1000);
    const warned: string[] = [];
    const forge = { db, log: { warn: (m: string) => warned.push(m) } } as never;
    const reachOf = (r: { id: string }): PullReach =>
      r.id === "a3" ? reach({ adapter: () => Promise.reject(new Error("boom")) }) : reach();
    expect(await pullDue(forge, Date.now, reachOf)).toEqual(["due"]);
    expect(posts).toBe(1);
    expect(warned).toEqual(["could not pull an adapter"]);
    expect(await pullDue(forge, Date.now, reachOf)).toEqual([]);
    expect(posts).toBe(1);
  });
});

describe("postPull", () => {
  const seen: { method: string; path: string }[] = [];
  let answer: () => Response = () => new Response(good);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname });
      return answer();
    },
  });
  const port = server.port ?? 0;
  afterAll(() => server.stop(true));

  test("POSTs /pull on loopback and hands back the status and body", async () => {
    expect(await postPull(port)).toEqual({ status: 200, body: good });
    expect(seen).toEqual([{ method: "POST", path: "/pull" }]);
  });

  test("a body over 64 KB is cut off and named", async () => {
    answer = () => new Response("x".repeat(PULL_BODY_MAX + 1));
    expect(await postPull(port)).toEqual({ error: `body is over ${PULL_BODY_MAX} bytes` });
  });

  test("an app that answers too slowly did not answer", async () => {
    answer = () => new Response(new ReadableStream({ start() {} }));
    expect(await postPull(port, 50)).toEqual({ error: "the app did not answer" });
  });
});

test("the timer does not start under the test harness", () => {
  expect(startPullSchedule({} as never)).toBeUndefined();
});
