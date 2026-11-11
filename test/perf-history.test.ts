/** Route p95 by the hour (#11477): the write, the cap, the purge, and the admin read. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createHourLedger, HOUR_MS, MAX_HOURS, MAX_ROUTES, readHours, routeHours, type HourLedger } from "../src/perf/history.ts";
import { createPerfRecord } from "../src/perf/record.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let adminToken: string;
let plainToken: string;
const now = 500 * HOUR_MS + 30 * 60_000;
const hour = 500;

const recordWith = (routes: number, each = 10) => {
  const r = createPerfRecord();
  for (let i = 0; i < routes; i++)
    for (let k = 1; k <= each; k++) r.add(`/r${i}`, { at: now - k * 1000, ms: k * 10 + i, signedIn: false, phases: [] });
  return r;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-perf-history-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
  if (!a.ok) throw new Error(a.error);
  adminToken = createToken(app.db, a.value.id, "t", "ro").token;
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(String(b.error));
  plainToken = createToken(app.db, b.value.id, "t", "ro").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const count = () => app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM route_hour").get()!.n;

const feed = (r: ReturnType<typeof createPerfRecord>, at: number, ms: number, route = "/r0") =>
  r.add(route, { at, ms, signedIn: false, phases: [] });
const step = (ledger: HourLedger, r: ReturnType<typeof createPerfRecord>, t: number) => {
  ledger.note(r, t);
  return ledger.write(app.db, t);
};

test("a write keeps one row per route with n, p50 and p95, replaced never duplicated", () => {
  app.db.query("DELETE FROM route_hour").run();
  const ledger = createHourLedger();
  expect(step(ledger, recordWith(2), now)).toBe(2);
  expect(routeHours(app.db, 1, now)).toEqual([
    { route: "/r0", hour, n: 10, p50: 50, p95: 100 },
    { route: "/r1", hour, n: 10, p50: 51, p95: 101 },
  ]);
  step(createHourLedger(), recordWith(2), now);
  expect(count()).toBe(2);
});

test("traffic at 10:50 is filed under 10, though the tick that sees it runs at 11:00", () => {
  app.db.query("DELETE FROM route_hour").run();
  const r = createPerfRecord();
  const ledger = createHourLedger();
  const at = 499 * HOUR_MS + 50 * 60_000;
  feed(r, at, 900);
  step(ledger, r, 500 * HOUR_MS); // minute 0 of the next hour
  expect(app.db.query("SELECT route, hour, n FROM route_hour").all()).toEqual([{ route: "/r0", hour: 499, n: 1 }]);
});

test("a row is the whole hour's p95, not the last 15 minutes'", () => {
  app.db.query("DELETE FROM route_hour").run();
  const r = createPerfRecord();
  const ledger = createHourLedger();
  const start = 500 * HOUR_MS;
  feed(r, start + 60_000, 5000); // slow, early
  step(ledger, r, start + 2 * 60_000);
  for (let m = 20; m <= 50; m += 5) {
    feed(r, start + m * 60_000, 10);
    step(ledger, r, start + m * 60_000);
  }
  const [row] = routeHours(app.db, 1, start + 55 * 60_000);
  expect(row!.n).toBe(8);
  expect(row!.p95).toBe(5000); // the early slow request is long out of the 15-minute window
});

test("an empty record writes nothing, and a restart never thins an hour's row", () => {
  app.db.query("DELETE FROM route_hour").run();
  expect(step(createHourLedger(), createPerfRecord(), now)).toBe(0);
  expect(count()).toBe(0);
  step(createHourLedger(), recordWith(1, 10), now);
  const r = createPerfRecord();
  feed(r, now - 1000, 1);
  step(createHourLedger(), r, now); // a restarted process saw one request
  expect(routeHours(app.db, 1, now)[0]!.n).toBe(10);
});

test("at most 200 routes are written, the busiest first", () => {
  app.db.query("DELETE FROM route_hour").run();
  const r = recordWith(MAX_ROUTES);
  feed(r, now - 500, 5, "/extra");
  expect(step(createHourLedger(), r, now)).toBe(MAX_ROUTES);
  expect(count()).toBe(MAX_ROUTES);
  expect(routeHours(app.db, 1, now).some((x) => x.route === "/extra")).toBe(false);
});

test("a row older than 168 hours is deleted in the same write", () => {
  app.db.query("DELETE FROM route_hour").run();
  const put = app.db.query("INSERT INTO route_hour (route, hour, n, p50, p95) VALUES (?1, ?2, 1, 1, 1)");
  put.run("/old", hour - 8 * 24);
  put.run("/edge", hour - MAX_HOURS);
  put.run("/kept", hour - MAX_HOURS + 1);
  step(createHourLedger(), recordWith(1), now);
  const left = app.db.query<{ route: string }, []>("SELECT route FROM route_hour ORDER BY route").all().map((x) => x.route);
  expect(left).toEqual(["/kept", "/r0"]);
});

test("hours is a whole number 1 to 168", () => {
  expect([readHours(null), readHours("1"), readHours("168"), readHours("0"), readHours("169"), readHours("x"), readHours("-1"), readHours("1.5")]).toEqual([24, 1, 168, null, null, null, null, null]);
});

test("the API answers an admin, and refuses hours=0 with 400, a non-admin with 403 and no one with 401", async () => {
  const url = `${servers.url}/api/v1/telemetry/routes`;
  const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
  const bad = await fetch(`${url}?hours=0`, h(adminToken));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error).toBe("invalid_hours");
  expect((await fetch(`${url}?hours=169`, h(adminToken))).status).toBe(400);
  expect((await fetch(url, h(plainToken))).status).toBe(403);
  expect((await fetch(url)).status).toBe(401);
  app.db.query("DELETE FROM route_hour").run();
  app.db.query("INSERT INTO route_hour (route, hour, n, p50, p95) VALUES ('/x', ?1, 3, 1, 2)").run(Math.floor(Date.now() / HOUR_MS));
  const ok = await fetch(`${url}?hours=2`, h(adminToken));
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as any;
  expect(body.hours).toBe(2);
  expect(body.rows).toEqual([{ route: "/x", hour: Math.floor(Date.now() / HOUR_MS), n: 3, p50: 1, p95: 2 }]);
});
