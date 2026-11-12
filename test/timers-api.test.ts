/**
 * Timers seen and steered (#11595): an app arms and cancels its own timers with
 * its own token; the owner reads schedules and runs, pauses and resumes them
 * over the API and the app's page; a stranger gets the 404; a failed run asks
 * the owner once however long it keeps failing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { scheduleLines } from "../src/actions/schedules.ts";
import { parseSchedules } from "../src/apps/schedule_spec.ts";
import { mintAppToken } from "../src/apps/token.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { dueTimers, recordRun, syncSchedules } from "../src/core/timers.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("timers over the API and the page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let appId: string;
  let appToken: string;
  let ownerRw: string;
  let strangerRw: string;
  let cookie: string;

  const call = (method: string, path: string, token: string | undefined, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { connection: "close", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-timers-"));
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
    const stranger = await make("dee");
    const repo = await createRepo(app, cy, { name: "paper", visibility: "private", description: "" });
    if (!repo.ok) throw new Error(String(repo.error));
    const row = insertApp(app.db, { repoId: repo.value.id, slug: "paper", access: "private" });
    if (!row.ok) throw new Error(row.error);
    appId = row.value.id;
    appToken = mintAppToken(app.db, cy.id, "paper", "production").token;
    ownerRw = createToken(app.db, cy.id, "me", "rw").token;
    strangerRw = createToken(app.db, stranger.id, "me", "rw").token;
    const specs = parseSchedules([{ name: "print", cron: "30 6 * * *", timezone: "America/Chicago", path: "/jobs/print" }]);
    if (!specs.ok) throw new Error(specs.error);
    syncSchedules(app.db, appId, "production", specs.value, "c1", Date.parse("2026-11-12T00:00:00Z"));
    const r = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "cy", password: "a-good-passphrase" }), redirect: "manual" });
    cookie = `${(r.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("an app arms a one-shot with its own token: in, at, a body, a key; and cancels by key", async () => {
    const armed = await call("POST", "/api/v1/timers", appToken, { in: "10m", path: "/jobs/digest", key: "digest-1", body: { n: 1 } });
    expect(armed.status).toBe(201);
    const timer = ((await armed.json()) as { timer: { key: string; at: string; env: string } }).timer;
    expect([timer.key, timer.env]).toEqual(["digest-1", "production"]);
    expect(Date.parse(timer.at) - Date.now()).toBeGreaterThan(9 * 60_000);
    // The same key again replaces the timer: one pending per key.
    expect((await call("POST", "/api/v1/timers", appToken, { at: "2027-03-01T00:00:00Z", path: "/jobs/digest", key: "digest-1" })).status).toBe(201);
    expect(app.db.query("SELECT COUNT(*) AS n FROM timer WHERE key = 'digest-1'").get()).toEqual({ n: 1 });
    expect((await call("DELETE", "/api/v1/timers/digest-1", appToken)).status).toBe(200);
    expect((await call("DELETE", "/api/v1/timers/digest-1", appToken)).status).toBe(404);
  });

  test("a person's token, no token, and bad input arm nothing", async () => {
    expect((await call("POST", "/api/v1/timers", ownerRw, { in: 5, path: "/x" })).status).toBe(401);
    expect((await call("POST", "/api/v1/timers", undefined, { in: 5, path: "/x" })).status).toBe(401);
    for (const bad of [{ path: "/x" }, { in: 5, at: "2030-01-01T00:00:00Z", path: "/x" }, { in: 5, path: "http://evil/x" }, { in: 5, path: "/x", key: "a b" }, { in: "9999d", path: "/x" }, { in: 5, path: "/x", extra: 1 }, { in: 5, path: "/x", body: "x".repeat(70_000) }])
      expect((await call("POST", "/api/v1/timers", appToken, bad)).status).toBe(422);
  });

  test("the per-app limit is a setting", async () => {
    process.env["FORGE_TIMERS_PER_APP"] = "2";
    try {
      expect((await call("POST", "/api/v1/timers", appToken, { in: 5, path: "/a", key: "l1" })).status).toBe(201);
      expect((await call("POST", "/api/v1/timers", appToken, { in: 5, path: "/a", key: "l2" })).status).toBe(201);
      expect((await call("POST", "/api/v1/timers", appToken, { in: 5, path: "/a", key: "l3" })).status).toBe(429);
    } finally {
      delete process.env["FORGE_TIMERS_PER_APP"];
    }
    for (const k of ["l1", "l2"]) await call("DELETE", `/api/v1/timers/${k}`, appToken);
  });

  test("the owner reads the schedule; a stranger gets the 404", async () => {
    const mine = await call("GET", "/api/v1/repos/cy/paper/schedules", ownerRw);
    expect(mine.status).toBe(200);
    const items = ((await mine.json()) as { items: { name: string; cron: string; timezone: string; paused: boolean; nextAt: number; last: null; line: string }[] }).items;
    expect(items).toHaveLength(1);
    expect([items[0]!.name, items[0]!.cron, items[0]!.timezone, items[0]!.nextAt, items[0]!.last]).toEqual(["print", "30 6 * * *", "America/Chicago", Date.parse("2026-11-12T12:30:00Z"), null]);
    expect(items[0]!.line).toContain("next Thu 12 Nov 06:30 CST");
    expect((await call("GET", "/api/v1/repos/cy/paper/schedules", strangerRw)).status).toBe(404);
  });

  test("run now queues one run; pause and resume hold and release; a stranger cannot", async () => {
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/print/run", strangerRw)).status).toBe(404);
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/print/run", ownerRw)).status).toBe(200);
    expect(dueTimers(app.db, Date.now() + 1000).filter((t) => t.name === "print" && t.kind === "once")).toHaveLength(1);
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/print/pause", ownerRw)).status).toBe(200);
    const paused = ((await (await call("GET", "/api/v1/repos/cy/paper/schedules", ownerRw)).json()) as { items: { paused: boolean; nextAt: number | null }[] }).items;
    expect([paused[0]!.paused, paused[0]!.nextAt]).toEqual([true, null]);
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/print/resume", ownerRw)).status).toBe(200);
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/print/nope", ownerRw)).status).toBe(422);
    expect((await call("POST", "/api/v1/repos/cy/paper/schedules/missing/run", ownerRw)).status).toBe(404);
  });

  test("the app's page shows the schedule in one row with Run now and Pause", async () => {
    const page = await (await fetch(`${servers.url}/cy/paper`, { headers: { cookie } })).text();
    expect(page).toContain('id="schedules"');
    expect(page).toContain("<code>print</code>");
    expect(page).toContain("30 6 * * *");
    expect(page).toContain('action="/cy/paper/app/schedules/print/run?env=production"');
    expect(page).toContain("Pause");
  });

  test("the page's Run now is a same-origin POST that goes back to the page", async () => {
    const post = (origin: string) => fetch(`${servers.url}/cy/paper/app/schedules/print/run?env=production`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams(), redirect: "manual" });
    expect((await post("https://evil.example")).status).toBe(403);
    const ok = await post(servers.url);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toContain("#schedules");
  });

  test("a failed run asks the owner once, however many days it keeps failing", () => {
    const cy = getUserByName(app.db, "cy")!;
    const dee = getUserByName(app.db, "dee")!;
    expect(scheduleLines(app, cy)).toEqual([]);
    const fail = (id: number) =>
      recordRun(app.db, { appId, env: "production", name: "print", idemKey: `paper:print:${id}`, scheduledAt: id, startedAt: id, finishedAt: id, attempts: 4, status: "failed", httpStatus: 500, response: null, error: "the app answered 500, after 4 attempts", lateMs: 0, lateReason: null, durationMs: 5 });
    fail(1);
    const first = scheduleLines(app, cy);
    expect(first).toHaveLength(1);
    expect(first[0]!.line).toBe("paper: Schedule print failed: the app answered 500, after 4 attempts");
    fail(2);
    expect(scheduleLines(app, cy)[0]!.items).toEqual(first[0]!.items);
    expect(scheduleLines(app, dee)).toEqual([]);
    recordRun(app.db, { appId, env: "production", name: "print", idemKey: "k", scheduledAt: 3, startedAt: 3, finishedAt: 3, attempts: 1, status: "ok", httpStatus: 200, response: "ok", error: null, lateMs: 0, lateReason: null, durationMs: 5 });
    expect(scheduleLines(app, cy)).toEqual([]);
  });
});
