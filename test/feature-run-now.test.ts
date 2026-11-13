/**
 * Run now (#10108): an admin runs one scheduled tool from Settings › Features,
 * through the schedule's own call, recorded as its fire. Tried with a fake
 * reach: a good call, a failing one, an asleep app (never reached), a call
 * already running (never doubled); and on a forge with no app runtime, where a
 * non-admin gets the 404 and an admin is told the app is asleep.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { RUN_REFUSALS, runNow } from "../src/apps/feature_run.ts";
import { fireOne, type Reach } from "../src/apps/feature_schedule.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { lastFires, recordFire } from "../src/core/feature_fires.ts";
import { absorb } from "../src/core/features.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { createUser } from "../src/core/users.ts";
import { migrate } from "../src/kernel/migrate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

const HOUR = 3_600_000;
const schedule = [{ tool: "scan", everyMs: HOUR }];
let seen: string[] = [];
let answer: () => Response = () => Response.json({ ok: true });
let hold: Promise<void> | undefined;
const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    seen.push(new URL(req.url).pathname);
    if (hold) await hold;
    return answer();
  },
});
const reach = (over: Partial<Reach> = {}): Reach => ({ port: () => stub.port, declared: async () => ({ tools: ["scan"], schedule }), ...over });
afterAll(() => stub.stop(true));

describe("fireOne", () => {
  let db: Database;
  const fresh = () => {
    db = new Database(":memory:");
    migrate(db, migrationFiles);
    absorb(db, "a1", "admin", "Radar", "/");
    seen = [];
    answer = () => Response.json({ ok: true });
    hold = undefined;
  };

  test("a good call is made once and recorded as the fire, even inside the interval", async () => {
    fresh();
    recordFire(db, "a1", { tool: "scan", at: 1, ok: false, error: "old", durationMs: 1 });
    expect(await fireOne(db, "a1", "scan", reach(), () => 10)).toEqual({ ok: true });
    expect(seen).toEqual(["/forge/tools/scan"]);
    expect(lastFires(db, "a1")).toEqual([{ tool: "scan", at: 10, ok: true, error: null, durationMs: 0 }]);
  });

  test("a failing call is recorded with its sentence", async () => {
    fresh();
    answer = () => new Response("no", { status: 500 });
    expect(await fireOne(db, "a1", "scan", reach(), () => 5)).toEqual({ ok: true });
    expect(lastFires(db, "a1")[0]).toMatchObject({ ok: false, error: "the app answered 500" });
  });

  test("an asleep app is refused and not called", async () => {
    fresh();
    expect(await fireOne(db, "a1", "scan", reach({ port: () => undefined }))).toEqual({ ok: false, why: "asleep" });
    expect(seen).toEqual([]);
    expect(lastFires(db, "a1")).toEqual([]);
  });

  test("a call already running is refused, not doubled", async () => {
    fresh();
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const first = fireOne(db, "a1", "scan", reach());
    while (seen.length === 0) await Bun.sleep(1);
    expect(await fireOne(db, "a1", "scan", reach())).toEqual({ ok: false, why: "in_flight" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(seen.length).toBe(1);
  });

  test("a tool not on the schedule, or an app not absorbed, is refused", async () => {
    fresh();
    expect(await fireOne(db, "a1", "other", reach())).toEqual({ ok: false, why: "not_scheduled" });
    expect(await fireOne(db, "nope", "scan", reach())).toEqual({ ok: false, why: "not_absorbed" });
    expect(seen).toEqual([]);
  });
});

describe("what is said", () => {
  const db = new Database(":memory:");
  migrate(db, migrationFiles);
  absorb(db, "a1", "admin", "Radar", "/");

  test("a good call says ran; a failing one says ran and failed with why; a refusal has its sentence", async () => {
    answer = () => Response.json({ ok: true });
    expect(await runNow(db, "a1", "scan", reach())).toEqual({ ok: true, message: "scan ran." });
    answer = () => new Response("no", { status: 500 });
    expect(await runNow(db, "a1", "scan", reach())).toEqual({ ok: false, message: "scan ran and failed: the app answered 500." });
    expect(await runNow(db, "a1", "scan", reach({ port: () => undefined }))).toEqual({ ok: false, message: RUN_REFUSALS.asleep });
  });

  test("a reach that throws is a refusal, and a dead port a recorded failure, never a throw", async () => {
    const boom = reach({ declared: async () => { throw new Error("x"); } });
    expect(await runNow(db, "a1", "scan", boom)).toEqual({ ok: false, message: RUN_REFUSALS.not_scheduled });
    expect((await runNow(db, "a1", "scan", reach({ port: () => 1 }))).message).toBe("scan ran and failed: the app did not answer.");
  });
});

describe("the route", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let appId: string;
  let adaCookie: string;
  let cyCookie: string;
  const signIn = async (username: string): Promise<string> => {
    const r = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username, password: "a-good-passphrase" }), redirect: "manual" });
    return `${(r.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };
  const web = (cookie: string, path: string, post = false) =>
    fetch(`${servers.url}${path}`, { method: post ? "POST" : "GET", headers: { cookie, origin: servers.url }, redirect: "manual", ...(post ? { body: new URLSearchParams() } : {}) });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-run-now-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    await make("ada", true);
    const cy = await make("cy");
    promote(app.db, cy);
    const made = await createRepo(app, cy, { name: "radar", visibility: "private", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    const forgeJson = JSON.stringify({
      app: { run: "bun run src/server.ts" },
      feature: { name: "Radar", page: "/", tools: { scan: { description: "Scan" } }, schedule: [{ tool: "scan", every: "1h" }] },
    });
    const committed = await commitToBranch(app, cy, made.value, { message: "feature", files: [{ path: "forge.json", content: forgeJson }] });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const row = insertApp(app.db, { repoId: made.value.id, slug: "radar", access: "private" });
    if (!row.ok) throw new Error(row.error);
    appId = row.value.id;
    absorb(app.db, appId, "admin", "Radar", "/");
    recordFire(app.db, appId, { tool: "scan", at: Date.now(), ok: true, error: null, durationMs: 3 });
    adaCookie = await signIn("ada");
    cyCookie = await signIn("cy");
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("the row has Run now, a POST form", async () => {
    const page = await (await web(adaCookie, "/settings/features/radar")).text();
    expect(page).toContain('action="/settings/features/radar/run/scan"');
    expect(page).toContain("Run now");
  });

  test("a non-admin gets the 403", async () => {
    expect((await web(cyCookie, "/settings/features/radar/run/scan", true)).status).toBe(403);
  });

  test("an admin on an asleep app is sent back with a sentence, and nothing is recorded", async () => {
    const before = lastFires(app.db, appId);
    const res = await web(adaCookie, "/settings/features/radar/run/scan", true);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/features/radar");
    expect(lastFires(app.db, appId)).toEqual(before);
  });
});
