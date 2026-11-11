/** A maintenance duty's switch (#11205): the API, the MCP, the page, and three errors in a row. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Duty } from "../src/maintain/duty.ts";
import { dutyState, isPaused, pauseOnErrors, setPaused } from "../src/maintain/pause.ts";
import { duties } from "../src/maintain/registry.ts";
import { startMaintain } from "../src/maintain/runner.ts";
import { dutySwitchScreen, entry as switchEntry, flipDuty } from "../src/tui/screens/dutyswitch.ts";
import { quietLogs } from "./helpers/globals.ts";
const ROOMY = { runsPerDay: 100000, dollarsPerDay: 10000, reason: "test" };

quietLogs();
let root = "";
let app: App;
let servers: Servers;
let admin = "";
let ro = "";
const name = duties[0]!.name;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-pause-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error("user");
  admin = createToken(app.db, a.value.id, "a", "admin").token;
  ro = createToken(app.db, a.value.id, "r", "ro").token;
});
afterAll(() => {
  servers.stop?.();
  rmSync(root, { recursive: true, force: true });
});

const post = (token: string, n: string, body: unknown) =>
  fetch(`${servers.url}/api/v1/maintenance/duties/${n}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const mcp = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "maintenance", arguments: args } }),
  });
  const b = (await res.json()) as any;
  return { error: b.result.isError === true, text: b.result.content[0].text as string };
};

test("the API pauses and resumes a duty, admin scope only, unknown names and bad bodies refused", async () => {
  expect((await post(ro, name, { paused: true })).status).toBe(403);
  expect((await post(admin, "nope", { paused: true })).status).toBe(404);
  expect((await post(admin, name, { paused: "yes" })).status).toBe(422);
  expect((await post(admin, name, { paused: true })).status).toBe(200);
  expect(isPaused(app.db, name)).toBe(true);
  const list = (await (await fetch(`${servers.url}/api/v1/maintenance/duties`, { headers: { authorization: `Bearer ${ro}` } })).json()) as any;
  expect(list.duties.find((d: any) => d.name === name).says).toContain("paused");
  expect((await post(admin, name, { paused: false })).status).toBe(200);
  expect(isPaused(app.db, name)).toBe(false);
});

test("the MCP maintenance tool pauses and resumes with the same words", async () => {
  const p = await mcp(admin, { action: "pause-duty", duty: name });
  expect(p.error).toBe(false);
  expect(p.text).toContain(`${name} is paused.`);
  expect((await mcp(admin, { action: "status" })).text).toContain(`${name}: paused`);
  expect((await mcp(ro, { action: "pause-duty", duty: name })).error).toBe(true);
  expect((await mcp(admin, { action: "resume-duty", duty: "nope" })).error).toBe(true);
  expect((await mcp(admin, { action: "resume-duty", duty: name })).text).toContain(`${name} is on again.`);
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
const form = (cookie: string, n: string, fields: Record<string, string>, origin = servers.url) =>
  fetch(`${servers.url}/maintenance/duties/${n}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
  });

test("the page lists each duty once, its switch in the row", async () => {
  const html = await (await fetch(`${servers.url}/maintenance`, { headers: { authorization: `Bearer ${admin}` } })).text();
  expect(html).toContain(`action="/maintenance/duties/${name}"`);
  expect(html.split(`<dt>${name}</dt>`).length - 1).toBe(1);
  expect(html.split('id="maintenance-duties"').length - 1).toBe(1);
  expect(html).not.toContain('id="maintenance-switches"');
});

test("the page form flips a duty for an admin; a non-admin, a cross-origin post and a stray value change nothing", async () => {
  app.db.exec("DELETE FROM maintenance_duty_state");
  const alice = await login("alice");
  const bob = await login("bob");
  expect((await form(bob, name, { paused: "yes" })).status).toBeGreaterThanOrEqual(400);
  expect(isPaused(app.db, name)).toBe(false);
  expect((await form(alice, name, { paused: "yes" }, "https://evil.example")).status).toBe(403);
  expect(isPaused(app.db, name)).toBe(false);
  expect((await form(alice, name, { paused: "maybe" })).status).toBe(303);
  expect(isPaused(app.db, name)).toBe(false);
  expect((await form(alice, "nope", { paused: "yes" })).status).toBe(303);
  expect((await form(alice, name, { paused: "yes" })).status).toBe(303);
  expect(isPaused(app.db, name)).toBe(true);
  expect(await (await fetch(`${servers.url}/maintenance`, { headers: { cookie: alice } })).text()).toContain("Resume");
  expect((await form(alice, name, { paused: "no" })).status).toBe(303);
  expect(isPaused(app.db, name)).toBe(false);
});

test("the terminal switch is offered to an admin person only and flips the duty through the same code", () => {
  app.db.exec("DELETE FROM maintenance_duty_state");
  const session = (user: unknown) => ({ user, app, db: app.db }) as never;
  const adminUser = { id: "a", username: "alice", isAdmin: true, kind: "person" };
  expect(switchEntry.offered(session(adminUser))).toBe(true);
  expect(switchEntry.offered(session({ ...adminUser, kind: "agent" }))).toBe(false);
  expect(switchEntry.offered(session({ ...adminUser, isAdmin: false }))).toBe(false);
  expect(flipDuty(session({ ...adminUser, isAdmin: false }), 0)).toBe("");
  expect(isPaused(app.db, name)).toBe(false);
  expect(flipDuty(session(adminUser), 0)).toBe(`${name} is paused.`);
  expect(isPaused(app.db, name)).toBe(true);
  const screen = dutySwitchScreen(session(adminUser), { invalidate: () => undefined } as never);
  screen.key({ key: "enter" } as never);
  expect(isPaused(app.db, name)).toBe(false);
});

test("a paused duty does not run; three errors in a row pause it saying the last error; resume starts the count again", async () => {
  app.db.exec("DELETE FROM maintenance_run; DELETE FROM maintenance_duty_state");
  let calls = 0;
  const bad: Duty = { name: "t-bad", intervalMs: 1, budget: ROOMY, run: () => { calls++; throw new Error(`boom ${calls}`); } };
  const m = startMaintain(app, { duties: [bad], everyMs: 1e9 });
  m.stop();
  const t = (i: number) => new Date(Date.UTC(2026, 10, 11, 0, 0, i));
  await m.tick(t(1));
  await m.tick(t(2));
  expect(isPaused(app.db, "t-bad")).toBe(false);
  await m.tick(t(3));
  expect(isPaused(app.db, "t-bad")).toBe(true);
  expect(dutyState(app.db, "t-bad").says).toContain("last error: failed: boom 3");
  await m.tick(t(4));
  expect(calls).toBe(3);
  // Resumed by hand: it runs again, and one more error does not re-pause it at once.
  setPaused(app.db, "t-bad", false, "alice");
  await m.tick(t(5));
  expect(calls).toBe(4);
  expect(isPaused(app.db, "t-bad")).toBe(false);
  await m.tick(t(6));
  expect(isPaused(app.db, "t-bad")).toBe(false);
  await m.tick(t(7));
  expect(calls).toBe(6);
  expect(isPaused(app.db, "t-bad")).toBe(true);
});

test("an ok run in between keeps the count from reaching three", async () => {
  app.db.exec("DELETE FROM maintenance_run; DELETE FROM maintenance_duty_state");
  let n = 0;
  const flaky: Duty = { name: "t-flaky", intervalMs: 1, budget: ROOMY, run: () => { if (++n === 3) return { findings: [], actions: [] }; throw new Error("x"); } };
  const m = startMaintain(app, { duties: [flaky], everyMs: 1e9 });
  m.stop();
  for (let i = 1; i <= 5; i++) await m.tick(new Date(Date.UTC(2026, 10, 11, 0, 0, i)));
  expect(isPaused(app.db, "t-flaky")).toBe(false);
});

test("resuming through the API and through the page starts the count again", async () => {
  const fail = () => app.db.run("INSERT INTO maintenance_run (duty, started, finished, outcome) VALUES (?1, ?2, ?2, 'failed: x')", [name, new Date().toISOString()]);
  app.db.exec("DELETE FROM maintenance_run; DELETE FROM maintenance_duty_state");
  const viaApi = async () => {
    for (let i = 0; i < 3; i++) fail();
    expect(pauseOnErrors(app.db, name)).toBe(true);
  };
  await viaApi();
  expect((await post(admin, name, { paused: false })).status).toBe(200);
  fail();
  expect(pauseOnErrors(app.db, name)).toBe(false);
  fail();
  fail();
  expect(pauseOnErrors(app.db, name)).toBe(true);
  expect((await form(await login("alice"), name, { paused: "no" })).status).toBe(303);
  fail();
  expect(pauseOnErrors(app.db, name)).toBe(false);
  expect(isPaused(app.db, name)).toBe(false);
});
