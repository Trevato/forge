/** The duty runner (#11204): schedule, record, refusal of a finding without a probe, the example duty, the admin list. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { duties } from "../src/maintain/registry.ts";
import { startMaintain } from "../src/maintain/runner.ts";
import { latest } from "../src/maintain/runs.ts";
import type { Duty } from "../src/maintain/duty.ts";
import { quietLogs } from "./helpers/globals.ts";

const ROOMY = { runsPerDay: 100000, dollarsPerDay: 10000, reason: "test" };
quietLogs();

let root = "";
let app: App;
let servers: Servers;
let admin = "";
let bob = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-maintain-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("user");
  admin = createToken(app.db, a.value.id, "ro", "ro").token;
  bob = createToken(app.db, b.value.id, "ro", "ro").token;
});
afterAll(() => {
  servers.stop?.();
  rmSync(root, { recursive: true, force: true });
});

const probe = { kind: "measurement", what: "queue depth", number: 3, at: "2026-11-11T00:00:00.000Z" } as const;
const clear = () => app.db.exec("DELETE FROM maintenance_run");

test("a duty runs when due, not before its interval, and leaves a row with findings and probes", async () => {
  clear();
  let calls = 0;
  const duty: Duty = { name: "t-sched", intervalMs: 1000, budget: ROOMY, run: () => (calls++, { findings: [{ summary: "deep queue", probe }], actions: ["noted"] }) };
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  const t0 = new Date("2026-11-11T00:00:00Z");
  await m.tick(t0);
  await m.tick(new Date(t0.getTime() + 500));
  expect(calls).toBe(1);
  await m.tick(new Date(t0.getTime() + 1500));
  expect(calls).toBe(2);
  const [row] = latest(app.db, 1);
  expect(row).toMatchObject({ duty: "t-sched", outcome: "ok", findings: ["deep queue"], actions: ["noted"], probes: [probe] });
  expect(row!.started).toBe("2026-11-11T00:00:01.500Z");
  expect(Date.parse(row!.finished)).toBeGreaterThan(0);
});

test("a duty never runs twice at once", async () => {
  clear();
  let live = 0;
  let worst = 0;
  const duty: Duty = {
    name: "t-once", intervalMs: 0, budget: ROOMY,
    run: async () => { live++; worst = Math.max(worst, live); await new Promise((r) => setTimeout(r, 20)); live--; return { findings: [], actions: [] }; },
  };
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  await Promise.all([m.tick(), m.tick()]);
  expect(worst).toBe(1);
});

test("a finding without a probe is refused and the outcome says so", async () => {
  clear();
  const bad: Duty = { name: "t-bad", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [{ summary: "it is slow" }], actions: ["did a thing"] }) };
  const nan: Duty = { name: "t-nan", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [{ summary: "x", probe: { ...probe, number: NaN } }], actions: [] }) };
  const m = startMaintain(app, { duties: [bad, nan], everyMs: 1e9 });
  m.stop();
  await m.tick();
  const rows = latest(app.db, 5);
  const byName = Object.fromEntries(rows.map((r) => [r.duty, r]));
  expect(byName["t-bad"]!.outcome).toContain("refused");
  expect(byName["t-bad"]!.outcome).toContain("no probe");
  expect(byName["t-bad"]!.findings).toEqual([]);
  expect(byName["t-bad"]!.actions).toEqual([]);
  expect(byName["t-nan"]!.outcome).toContain("probe has no number");
});

test("a duty that throws is recorded as failed and the next still runs", async () => {
  clear();
  const boom: Duty = { name: "t-boom", intervalMs: 1, budget: ROOMY, run: () => { throw new Error("no"); } };
  const fine: Duty = { name: "t-fine", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) };
  const m = startMaintain(app, { duties: [boom, fine], everyMs: 1e9 });
  m.stop();
  await m.tick();
  const rows = latest(app.db, 5);
  expect(rows.find((r) => r.duty === "t-boom")!.outcome).toBe("failed: no");
  expect(rows.find((r) => r.duty === "t-fine")!.outcome).toBe("ok");
});

test("the example duty is registered and counts open pulls waiting over 24 hours, with its probe", async () => {
  clear();
  expect(duties.map((d) => d.name)).toContain("pulls-waiting");
  const now = new Date("2026-11-11T12:00:00Z");
  app.db.exec("PRAGMA foreign_keys = OFF");
  const ins = app.db.prepare("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, 'r', ?2, 'pull', 't', 'u', ?3, ?4)");
  ins.run("p1", 1, "open", "2026-11-09T00:00:00.000Z");
  ins.run("p2", 2, "open", "2026-11-11T11:00:00.000Z");
  ins.run("p3", 3, "closed", "2026-11-01T00:00:00.000Z");
  const m = startMaintain(app, { duties: duties.filter((d) => d.name === "pulls-waiting"), everyMs: 1e9 });
  m.stop();
  await m.tick(now);
  const [row] = latest(app.db, 1);
  expect(row!.outcome).toBe("ok");
  expect(row!.findings).toEqual(["1 open pull waiting over 24 hours"]);
  expect(row!.probes[0]).toMatchObject({ kind: "query", number: 1, at: now.toISOString() });
  app.db.exec("DELETE FROM issue WHERE id IN ('p1','p2','p3')");
});

test("the example duty's count searches an existing index, not the table", () => {
  const plan = (app.db.query("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull' AND state = 'open' AND parked = 0 AND created_at < ?1").all("x") as { detail: string }[]).map((r) => r.detail).join("\n");
  expect(plan).toMatch(/USING (COVERING )?INDEX/);
  expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
});

test("GET /api/v1/maintenance/runs lists the latest rows for an admin only", async () => {
  clear();
  const m = startMaintain(app, { duties: [{ name: "t-list", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) }], everyMs: 1e9 });
  m.stop();
  await m.tick();
  const get = (token?: string, q = "") => fetch(`${servers.url}/api/v1/maintenance/runs${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect((await get()).status).toBe(401);
  expect((await get(bob)).status).toBe(403);
  const res = await get(admin, "?limit=5");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runs: { duty: string; outcome: string }[] };
  expect(body.runs[0]).toMatchObject({ duty: "t-list", outcome: "ok" });
  expect((await get(admin, "?limit=abc")).status).toBe(200);
});

test("a hung duty is recorded as timed out and the next duty still runs, without overlapping itself", async () => {
  clear();
  let release = () => {};
  let starts = 0;
  const hung: Duty = { name: "t-hung", intervalMs: 1, budget: ROOMY, run: () => { starts++; return new Promise((r) => { release = () => r({ findings: [], actions: [] }); }); } };
  const fine: Duty = { name: "t-after", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) };
  const m = startMaintain(app, { duties: [hung, fine], everyMs: 1e9, timeoutMs: 20 });
  m.stop();
  await m.tick();
  const rows = latest(app.db, 5);
  expect(rows.find((r) => r.duty === "t-hung")!.outcome).toBe("failed: timed out");
  expect(rows.find((r) => r.duty === "t-after")!.outcome).toBe("ok");
  await m.tick(new Date(Date.now() + 10));
  expect(starts).toBe(1);
  release();
});

test("an empty finding reads refused:", async () => {
  clear();
  const d: Duty = { name: "t-empty", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [{ summary: " ", probe }], actions: [] }) };
  const m = startMaintain(app, { duties: [d], everyMs: 1e9 });
  m.stop();
  await m.tick();
  expect(latest(app.db, 1)[0]!.outcome).toBe("refused: a finding says nothing");
});

test("old rows are pruned to a cap per duty, and other duties keep theirs", async () => {
  clear();
  const a: Duty = { name: "t-a", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) };
  const b: Duty = { name: "t-b", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) };
  const m = startMaintain(app, { duties: [a, b], everyMs: 1e9, keep: 3 });
  m.stop();
  for (let i = 0; i < 6; i++) await m.tick(new Date(Date.now() + i * 10));
  const rows = latest(app.db, 100);
  expect(rows.filter((r) => r.duty === "t-a")).toHaveLength(3);
  expect(rows.filter((r) => r.duty === "t-b")).toHaveLength(3);
});

test("a duty name that is not lowercase words and dashes, or is registered twice, is refused at start", () => {
  const run = () => ({ findings: [], actions: [] });
  expect(() => startMaintain(app, { duties: [{ name: "Bad Name", intervalMs: 1, budget: ROOMY, run }], everyMs: 1e9 })).toThrow("not lowercase");
  expect(() => startMaintain(app, { duties: [{ name: "dup", intervalMs: 1, budget: ROOMY, run }, { name: "dup", intervalMs: 1, budget: ROOMY, run }], everyMs: 1e9 })).toThrow("twice");
});

test("the terminal screen lists runs for an admin and nothing for anyone else", async () => {
  clear();
  const m = startMaintain(app, { duties: [{ name: "t-tui", intervalMs: 1, budget: ROOMY, run: () => ({ findings: [], actions: [] }) }], everyMs: 1e9 });
  m.stop();
  await m.tick();
  const { runLines } = await import("../src/tui/screens/maintainruns.ts");
  const as = (isAdmin: boolean) => ({ user: { isAdmin }, db: app.db }) as never;
  expect(runLines(as(true)).some((l) => l.startsWith("t-tui"))).toBe(true);
  expect(runLines(as(false))).toEqual([]);
  expect(runLines({ user: undefined, db: app.db } as never)).toEqual([]);
});

const tight = (runsPerDay: number, dollarsPerDay = 10000) => ({ runsPerDay, dollarsPerDay, reason: "test" });

test("a duty past its runs budget is skipped with a budget row, and runs again the next day", async () => {
  clear();
  let calls = 0;
  const duty: Duty = { name: "t-runs", intervalMs: 1, budget: tight(2), run: () => (calls++, { findings: [], actions: [] }) };
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  const t0 = Date.parse("2026-11-11T01:00:00Z");
  for (let i = 0; i < 5; i++) await m.tick(new Date(t0 + i * 60_000));
  expect(calls).toBe(2);
  const rows = latest(app.db, 10).filter((r) => r.duty === "t-runs");
  expect(rows.filter((r) => r.outcome === "ok")).toHaveLength(2);
  const stops = rows.filter((r) => r.outcome.startsWith("budget:"));
  expect(stops).toHaveLength(1);
  expect(stops[0]!.outcome).toContain("runs per day");
  await m.tick(new Date("2026-11-12T00:00:01Z"));
  expect(calls).toBe(3);
});

test("a duty past its dollars budget is skipped and the row names dollars", async () => {
  clear();
  let calls = 0;
  const duty: Duty = { name: "t-dollars", intervalMs: 1, budget: tight(1000, 1), run: () => (calls++, { findings: [], actions: [], dollars: 0.6 }) };
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  const t0 = Date.parse("2026-11-11T01:00:00Z");
  for (let i = 0; i < 4; i++) await m.tick(new Date(t0 + i * 60_000));
  expect(calls).toBe(2);
  const [row] = latest(app.db, 1);
  expect(row!.outcome).toContain("budget: dollars per day");
});

test("a stored budget replaces the declared one, and a blank takes it back; the registered duties all declare a reason", async () => {
  clear();
  const { setBudget, budgetOf, parseBudget } = await import("../src/maintain/budget.ts");
  const duty: Duty = { name: "t-set", intervalMs: 1, budget: tight(5), run: () => ({ findings: [], actions: [] }) };
  setBudget(app.db, duty, "runs", 1, "u");
  expect(budgetOf(app.db, duty).runsPerDay).toBe(1);
  setBudget(app.db, duty, "runs", null, "u");
  expect(budgetOf(app.db, duty).runsPerDay).toBe(5);
  expect(parseBudget("runs", "0")).toBeUndefined();
  expect(parseBudget("runs", "1e3")).toBeUndefined();
  expect(parseBudget("dollars", "0.5")).toBe(0.5);
  for (const d of duties) expect(d.budget.reason.length).toBeGreaterThan(10);
});

test("POST /maintenance/budget moves a budget for an admin, refuses a bad number, and the page shows the reason", async () => {
  clear();
  const { createSession } = await import("../src/core/sessions.ts");
  const adminId = (app.db.query("SELECT id FROM user WHERE username = 'alice'").get() as { id: string }).id;
  const cookie = `forge_session=${createSession(app.db, adminId).token}`;
  const post = (body: Record<string, string>) =>
    fetch(`${servers.url}/maintenance/budget`, { method: "POST", redirect: "manual", headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const name = duties[0]!.name;
  expect((await post({ duty: name, runs: "7", dollars: "2.5" })).status).toBe(303);
  const { budgetOf } = await import("../src/maintain/budget.ts");
  expect(budgetOf(app.db, duties[0]!)).toEqual({ runsPerDay: 7, dollarsPerDay: 2.5 });
  await post({ duty: name, runs: "0", dollars: "2.5" });
  expect(budgetOf(app.db, duties[0]!).runsPerDay).toBe(7);
  await post({ duty: name, runs: "", dollars: "" });
  expect(budgetOf(app.db, duties[0]!).runsPerDay).toBe(duties[0]!.budget.runsPerDay);
  const page = await (await fetch(`${servers.url}/maintenance`, { headers: { cookie } })).text();
  expect(page).toContain(duties[0]!.budget.reason);
});

test("only an admin moves a budget: a non-admin, a guest and a cross-origin post are refused and nothing changes", async () => {
  const { createSession } = await import("../src/core/sessions.ts");
  const { budgetOf } = await import("../src/maintain/budget.ts");
  const id = (n: string) => (app.db.query("SELECT id FROM user WHERE username = ?1").get(n) as { id: string }).id;
  const own = { ...budgetOf(app.db, duties[0]!) };
  const post = (cookie: string, origin: string) =>
    fetch(`${servers.url}/maintenance/budget`, {
      method: "POST", redirect: "manual",
      headers: { ...(cookie ? { cookie } : {}), origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ duty: duties[0]!.name, runs: "3", dollars: "3" }),
    });
  const bobCookie = `forge_session=${createSession(app.db, id("bob")).token}`;
  const aliceCookie = `forge_session=${createSession(app.db, id("alice")).token}`;
  await post(bobCookie, servers.url);
  expect(budgetOf(app.db, duties[0]!)).toEqual(own);
  await post("", servers.url);
  expect(budgetOf(app.db, duties[0]!)).toEqual(own);
  app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE username = 'bob'").run();
  await post(bobCookie, servers.url);
  expect(budgetOf(app.db, duties[0]!)).toEqual(own);
  app.db.query("UPDATE user SET is_agent = 0, is_admin = 0 WHERE username = 'bob'").run();
  const cross = await post(aliceCookie, "https://evil.example");
  expect(cross.status).toBeGreaterThanOrEqual(400);
  expect(budgetOf(app.db, duties[0]!)).toEqual(own);
});

test("a stored dollars budget is enforced, and a value equal to the declared one is not stored", async () => {
  clear();
  const { setBudget, budgetOf } = await import("../src/maintain/budget.ts");
  let calls = 0;
  const duty: Duty = { name: "t-stored", intervalMs: 1, budget: tight(1000, 100), run: () => (calls++, { findings: [], actions: [], dollars: 0.6 }) };
  setBudget(app.db, duty, "dollars", 1, "u");
  expect(budgetOf(app.db, duty).dollarsPerDay).toBe(1);
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  const t0 = Date.parse("2026-11-11T01:00:00Z");
  for (let i = 0; i < 4; i++) await m.tick(new Date(t0 + i * 60_000));
  expect(calls).toBe(2);
  expect(latest(app.db, 1)[0]!.outcome).toContain("of $1.00 spent");
  setBudget(app.db, duty, "dollars", 100, "u");
  setBudget(app.db, duty, "runs", 1000, "u");
  expect(app.db.query("SELECT COUNT(*) AS n FROM forge_setting WHERE key LIKE 'maintain.t-stored.%'").get()).toEqual({ n: 0 });
});

test("the budget screen moves a budget for an admin who is a person and shows nothing to anyone else", async () => {
  const { budgetLines, moveBudget } = await import("../src/tui/screens/dutybudgets.ts");
  const { budgetOf } = await import("../src/maintain/budget.ts");
  const id = (app.db.query("SELECT id FROM user WHERE username = 'alice'").get() as { id: string }).id;
  const as = (user: unknown) => ({ user, db: app.db }) as never;
  const adminS = as({ isAdmin: true, kind: "person", id, username: "alice" });
  const before = budgetOf(app.db, duties[0]!).runsPerDay;
  expect(budgetLines(adminS, 0).some((l) => l.startsWith("> " + duties[0]!.name))).toBe(true);
  moveBudget(adminS, 0, "runs", 1);
  expect(budgetOf(app.db, duties[0]!).runsPerDay).toBe(before + 1);
  moveBudget(adminS, 0, "runs", 0, true);
  expect(budgetOf(app.db, duties[0]!).runsPerDay).toBe(duties[0]!.budget.runsPerDay);
  for (const who of [as({ isAdmin: false, kind: "person", id }), as({ isAdmin: true, kind: "agent", id }), as(undefined)]) {
    expect(budgetLines(who, 0)).toEqual([]);
    expect(moveBudget(who, 0, "runs", 1)).toBe("");
  }
  expect(budgetOf(app.db, duties[0]!).runsPerDay).toBe(duties[0]!.budget.runsPerDay);
});

test("the budget screen's keys move the chosen duty's budget, and a refused session's keys do nothing", async () => {
  const { dutyBudgetScreen } = await import("../src/tui/screens/dutybudgets.ts");
  const { budgetOf } = await import("../src/maintain/budget.ts");
  const id = (app.db.query("SELECT id FROM user WHERE username = 'alice'").get() as { id: string }).id;
  let popped = 0;
  const ctx = { invalidate: () => {}, pop: () => popped++, theme: {} } as never;
  const press = (screen: { key?: (e: never) => boolean }, key: string) => screen.key!({ key, ctrl: false, alt: false } as never);
  const d = duties[0]!;
  const own = { ...budgetOf(app.db, d) };
  const screen = dutyBudgetScreen({ user: { isAdmin: true, kind: "person", id }, db: app.db } as never, ctx);
  press(screen, "+");
  expect(budgetOf(app.db, d).runsPerDay).toBe(own.runsPerDay + 1);
  press(screen, "-"); press(screen, "-");
  expect(budgetOf(app.db, d).runsPerDay).toBe(own.runsPerDay - 1);
  press(screen, "]");
  expect(budgetOf(app.db, d).dollarsPerDay).toBe(own.dollarsPerDay + 1);
  press(screen, "[");
  expect(budgetOf(app.db, d).dollarsPerDay).toBe(own.dollarsPerDay);
  press(screen, "+"); press(screen, "0");
  expect(budgetOf(app.db, d)).toEqual(own);
  expect(press(screen, "z")).toBe(false);
  press(screen, "q");
  expect(popped).toBe(1);
  const agent = dutyBudgetScreen({ user: { isAdmin: true, kind: "agent", id }, db: app.db } as never, ctx);
  press(agent, "+"); press(agent, "]");
  expect(budgetOf(app.db, d)).toEqual(own);
});
