/** Main-thread stalls are counted against the route running across them and read from `GET /metrics` (#9016). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { watchStalls } from "../src/kernel/loop_lag.ts";
import { openMetrics } from "../src/metrics/openmetrics.ts";
import { stallFamilies, TOP_ROUTES } from "../src/metrics/stalls.ts";
import { loopWatch, stallBlame } from "../src/perf/live.ts";
import { WORST_STALLS } from "../src/perf/stall_blame.ts";
import { createLoopWatch, HOUR_MS, NO_REQUEST } from "../src/perf/loop.ts";
import { createAgent } from "../src/actions/crew.ts";
import type { User } from "../src/core/users.ts";
import { stallSection } from "../src/web/pages/system.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { stallLines } from "../src/tui/screens/loopstalls.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { freshStallState } from "./helpers/stall-state.ts";

quietLogs();
freshStallState();

test("a deliberate stall during a route is counted against it", async () => {
  // The loop watcher on a clock the test moves: the route holds the thread
  // 400 ms of that clock, and the wake after it is late by that much.
  let t = 0;
  const w = createLoopWatch(250);
  const heard = new Promise<void>((resolve) => {
    const stop = watchStalls({ warn() {} }, 1_000, 5, () => t, (late, at) => {
      if (w.stalled(late, at) !== null) {
        stop();
        resolve();
      }
    });
  });
  const start = t;
  t += 400;
  w.finished("/slow/:id", start, t);
  await heard;
  // Armed at 0 to wake at 5; woke at 400: 395 ms late.
  const tally = w.tally(t);
  expect(tally.total).toEqual([{ route: "/slow/:id", ms: 395, count: 1 }]);
  expect(tally.hour).toEqual([{ route: "/slow/:id", ms: 395, count: 1 }]);
  const text = openMetrics(stallFamilies(tally));
  expect(text).toContain('forge_loop_stall_milliseconds_total{route="/slow/:id"} 395');
  expect(text).toContain('forge_loop_stalls_total{route="/slow/:id"} 1');
  expect(text).toContain('forge_loop_stall_hour_milliseconds{route="/slow/:id"} 395');
});

test("each route across a stall is charged the whole stall; none is charged to `none`", () => {
  const w = createLoopWatch(250);
  w.finished("/a", 0, 1000);
  w.finished("/b", 500, 900);
  w.stalled(600, 1000);
  w.stalled(300, 5000);
  const { total } = w.tally(5000);
  expect(total).toEqual([
    { route: "/a", ms: 600, count: 1 },
    { route: "/b", ms: 600, count: 1 },
    { route: NO_REQUEST, ms: 300, count: 1 },
  ]);
});

test("the hour forgets a stall an hour old; the totals keep it", () => {
  const w = createLoopWatch(250);
  w.finished("/old", 0, 1000);
  w.stalled(500, 1000);
  w.finished("/new", HOUR_MS, HOUR_MS + 1000);
  w.stalled(700, HOUR_MS + 1000);
  w.stalled(400, HOUR_MS + 1000);
  const tally = w.tally(HOUR_MS + 1000);
  expect(tally.hour).toEqual([{ route: "/new", ms: 1100, count: 2 }]);
  expect(tally.total.map((r) => r.route)).toEqual(["/new", "/old"]);
});

test("the hour lists the top routes, most milliseconds first, and always the flow route", () => {
  const w = createLoopWatch(250);
  for (let i = 0; i < TOP_ROUTES + 3; i++) {
    const at = 10_000 * (i + 1);
    w.finished(`/r${i}`, at - 1000, at);
    w.stalled(300 + i, at);
  }
  const text = openMetrics(stallFamilies(w.tally(10_000 * (TOP_ROUTES + 4))));
  const hourly = [...text.matchAll(/^forge_loop_stall_hour_milliseconds\{route="([^"]+)"\} (\d+)$/gm)].map((m) => [m[1], Number(m[2])]);
  expect(hourly.length).toBe(TOP_ROUTES + 1);
  expect(hourly[0]).toEqual([`/r${TOP_ROUTES + 2}`, 300 + TOP_ROUTES + 2]);
  expect(hourly.some(([r]) => r === "/r0")).toBe(false);
  expect(hourly.at(-1)).toEqual(["/api/v1/telemetry/flow", 0]);
});

let dir: string;
let app: App;
let servers: Servers;
let ro: string;
let alice: User;
let bob: User;
let bot: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-stall-route-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  ro = createToken(app.db, made.value.id, "t", "ro").token;
  const member = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!member.ok) throw new Error(member.error);
  bob = member.value;
  const agent = await createAgent(app, alice, { username: "stallbot", brief: "x" });
  if (!agent.ok) throw new Error(String(agent.error));
  // An admin agent: still not offered the screen, which is a person's.
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(agent.value.user.id);
  bot = { ...agent.value.user, isAdmin: true };
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("GET /metrics names the route a stall ran across", async () => {
  // This feeds the process's own watch, which every test file in this
  // process shares: the stall stays in its totals, so every assertion here
  // and elsewhere reads route-specific lines, never a sum or a row count.
  const health = await fetch(`${servers.url}/api/v1/health`);
  expect(health.status).toBe(200);
  // The server noted the request on the process's watch; a wake 400 ms late
  // now covers it, as main.ts's watcher would report it.
  expect(loopWatch.stalled(400, performance.now())).not.toBeNull();
  const text = await (await fetch(`${servers.url}/metrics`, { headers: { authorization: `Bearer ${ro}` } })).text();
  expect(text).toMatch(/^forge_loop_stalls_total\{route="\/api\/v1\/health"\} [1-9]/m);
  expect(text).toMatch(/^forge_loop_stall_hour_milliseconds\{route="\/api\/v1\/health"\} [1-9]/m);
  expect(text).toMatch(/^forge_loop_stall_hour_milliseconds\{route="\/api\/v1\/telemetry\/flow"\} \d+$/m);
});

const login = async (username: string): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

test("the stall section lists route, ms and count, the route escaped", () => {
  const text = stallSection([
    { route: "/a/<script>", ms: 1234.4, count: 3 },
    { route: "/api/v1/telemetry/flow", ms: 0, count: 0 },
  ]).text;
  expect(text).toContain("Main-thread stalls, last hour");
  expect(text).toContain('<td class="mono">/a/&lt;script&gt;</td><td class="num mono">1234</td><td class="num mono">3</td>');
  expect(text).not.toContain("<script>");
  expect(text).toContain('<td class="mono">/api/v1/telemetry/flow</td><td class="num mono">0</td><td class="num mono">0</td>');
});

test("/system shows the owner the stall section with the flow route; a member gets 404", async () => {
  const page = await fetch(`${servers.url}/system`, { headers: { cookie: await login("alice") } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('id="sys-stalls"');
  expect(html).toContain('<tr data-route="/api/v1/telemetry/flow">');
  expect((await fetch(`${servers.url}/system`, { headers: { cookie: await login("bob") } })).status).toBe(404);
});

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });
const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(80, 24), exitHooks: false });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

const quiet = { rows: [], mono: 0, wall: 0 };

test("the Stalls screen gives an admin person the rows and the door; nobody else either", () => {
  const rows = [{ route: "/slow/:id", ms: 812.6, count: 2 }, { route: "/api/v1/telemetry/flow", ms: 0, count: 0 }];
  const lines = stallLines(new Session(app, identity(alice)), rows, quiet);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("Stall ms");
  expect(lines[1]).toMatch(/^\/slow\/:id\s+813\s+2$/);
  expect(lines[2]).toMatch(/^\/api\/v1\/telemetry\/flow\s+0\s+0$/);
  expect(doors(alice)).toContain("stalls");
  for (const who of [bob, bot, undefined]) {
    expect(stallLines(new Session(app, identity(who)), rows, quiet)).toEqual([]);
    expect(doors(who)).not.toContain("stalls");
  }
});

test("the Stalls screen lists the hour's worst single stalls as /system does: what, ms, when (#11069)", () => {
  // One instant: 1,000,000 ms on the watcher's clock is 2026-11-10T12:00:00Z on the wall.
  const wall = Date.parse("2026-11-10T12:00:00Z");
  const worst = {
    rows: [
      { what: "/slow/:id", ms: 812.6, at: 1_000_000 - 90_000 }, // 90 s before: 11:58:30
      { what: "job:sampler", ms: 240.2, at: 1_000_000 - 3_600_000 + 1 }, // just inside the hour: 11:00:00
    ],
    mono: 1_000_000,
    wall,
  };
  const lines = stallLines(new Session(app, identity(alice)), [{ route: "/api/v1/telemetry/flow", ms: 0, count: 0 }], worst);
  expect(lines[2]).toBe("");
  expect(lines[3]).toMatch(/^Worst single stalls \(what ran\)\s+ms\s+When$/);
  expect(lines[4]).toMatch(/^\/slow\/:id\s+813\s+11:58:30 UTC$/);
  expect(lines[5]).toMatch(/^job:sampler\s+240\s+11:00:00 UTC$/);
  expect(lines).toHaveLength(6);
  expect(stallLines(new Session(app, identity(bob)), [], worst)).toEqual([]);
});

test("the Stalls screen reads the process's stall blame by default, the five /system reads", () => {
  const now = performance.now();
  for (const [ms, r] of [[300, "/a"], [800, "/b"], [250, "/c"], [500, "/d"], [700, "/e"], [210, "/f"]] as const)
    stallBlame.note({ at: now - 1_000, lateMs: ms, routes: [r], jobs: [] });
  const lines = stallLines(new Session(app, identity(alice)), []);
  const named = lines.slice(lines.indexOf("") + 2).map((l) => l.split(/\s+/)[0] ?? "");
  expect(named).toEqual(["/b", "/e", "/d", "/a", "/c"]);
  expect(stallBlame.worst(performance.now(), HOUR_MS, WORST_STALLS).map((s) => s.what)).toEqual(named);
  stallBlame.clear();
});
