/** Why builders sit idle (#5799): the first reason that holds, on home and in the terminal, from the scheduler's own checks. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { idleReason } from "../src/crew/idle_reason.ts";
import { writeStamp } from "../src/core/write_clock.ts";
import { kpiRow, kpiRowFor } from "../src/web/studio/kpi_row.ts";
import { cachedKpis, kpiCache } from "../src/web/studio/home_cache.ts";
import { readKpis } from "../src/flow/kpis.ts";
import { kpiLines } from "../src/flow/kpi_words.ts";
import { createSession } from "../src/core/sessions.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription, EVERYONE, setGrants } from "../src/core/subscriptions.ts";
import { type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { freshHome } from "./helpers/home-fresh.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import type { Repo } from "../src/core/repos.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let repo: Repo;
let builder: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-builders-idle-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  admin = a.value;
  const made = await createRepo(app, admin, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, admin, repo, { message: "Start", files: [{ path: "README.md", content: "# engine\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const agent = await createAgent(app, admin, { username: "mason" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, admin, repo, "mason").ok).toBe(true);
  builder = getUserByName(app.db, "mason")!;
  const on = await updateRepoSettings(app, admin, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Build.",
    autonomyCeilingUsd: 10,
    autonomySlots: 1,
    autonomyBy: admin.id,
  });
  expect(on.ok).toBe(true);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The reason rides in home's 60 s KPI answer (#7664): a test that changed the state forgets the answer first. */
const home = async (keep = false): Promise<string> => {
  if (!keep) kpiCache(app.db).clear();
  return freshHome(servers.url, `forge_session=${createSession(app.db, admin.id).token}; forge_mode=studio`);
};

async function terminal(): Promise<string> {
  const t = headlessTerminal(200, 40);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: admin },
    { terminal: t, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop();
  return text;
}

/** The builders tile's anchor on home. */
const tile = (page: string): string => /<a class="stat" href="[^"]*"[^>]*><span class="stat-label">Builders running.*?<\/a>/s.exec(page)?.[0] ?? "";

test("nothing ready: the map has nothing a builder may start", async () => {
  const page = await home();
  expect(tile(page)).toContain("nothing ready");
  expect(tile(page)).toContain('href="/map"');
  expect(await terminal()).toContain("Builders running 0 of 1 · nothing ready");
});

test("a ready issue and a builder with room: no reason is named", async () => {
  const opened = openIssue(app, admin, repo, { title: "Renderer" });
  if (!opened.ok) throw new Error(String(opened.error));
  const page = await home();
  expect(tile(page)).not.toContain("nothing ready");
  expect(tile(page)).toContain("running now");
  expect(await terminal()).not.toMatch(/Builders running 0 of 1 · (nothing|no sub|ceiling)/);
});

test("no subscription with headroom: the granted account's window is full", async () => {
  const sub = addSubscription(app.db, dir, { name: "espo", token: "sk-ant-oat01-" + "x".repeat(24) });
  if (!sub.ok) throw new Error(sub.error);
  setGrants(app.db, repo.id, EVERYONE, [sub.value.id]);
  const now = Date.now();
  noteLimit(app.db, sub.value.id, { window: "5h", resetsAt: new Date(now + 3_600_000).toISOString(), observedAt: new Date(now).toISOString(), said: "limit" });
  const page = await home();
  // The write stamp is the same at both clocks; only the window's reset moves.
  const stampBefore = writeStamp(app.db);
  const later = new Date(now + 2 * 3_600_000);
  expect(idleReason(app, new Date(now))?.word).toBe("no subscription with headroom");
  expect(idleReason(app, later)?.word).not.toBe("no subscription with headroom");
  expect(String(kpiRow(app.db, { now: new Date(now), idle: () => idleReason(app, new Date(now)) }))).toContain("no subscription with headroom");
  expect(String(kpiRow(app.db, { now: later, idle: () => idleReason(app, later) }))).not.toContain("no subscription with headroom");
  expect(writeStamp(app.db)).toBe(stampBefore);
  expect(tile(page)).toContain("no subscription with headroom");
  expect(tile(page)).toContain('href="/subscriptions"');
  expect(await terminal()).toContain("Builders running 0 of 1 · no subscription with headroom");
});

test("ceiling reached outranks the others", async () => {
  const spent = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: builder.id, reason: "assigned" });
  claimRun(app.db, spent.id);
  finishRun(app.db, spent.id, { state: "ok", summary: "done", costUsd: 12 });
  const page = await home();
  expect(tile(page)).toContain("ceiling reached");
  expect(tile(page)).toContain('href="/meter"');
  expect(await terminal()).toContain("Builders running 0 of 1 · ceiling reached");
});

test("every slot busy: no reason is shown", async () => {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: builder.id, reason: "assigned" });
  claimRun(app.db, run.id);
  const page = await home();
  expect(tile(page)).toContain("1 of 1");
  expect(tile(page)).not.toContain("ceiling reached");
  expect(await terminal()).toContain("Builders running 1 of 1");
  expect(await terminal()).not.toContain("ceiling reached");
});

test("both doors agree within home's 60 s KPI entry: the run ends, each says 0 of 1 and why (#7624)", async () => {
  const busy = await home();
  expect(tile(busy)).toContain("1 of 1");
  for (const r of app.db.query<{ id: string }, []>("SELECT id FROM run WHERE kind = 'agent' AND state = 'running'").all())
    finishRun(app.db, r.id, { state: "ok", summary: "done" });
  // Within the entry the counts changed, so the reason is asked again rather than left silent.
  const page = await home(true);
  expect(tile(page)).toContain("0 of 1");
  expect(tile(page)).toContain("ceiling reached");
  expect(await terminal()).toContain("Builders running 0 of 1 · ceiling reached");
});

test("the reason rides in the cached KPI answer: readKpis carries it, the tile and line print it (#7664)", async () => {
  for (const r of app.db.query<{ id: string }, []>("SELECT id FROM run WHERE kind = 'agent' AND state = 'running'").all())
    finishRun(app.db, r.id, { state: "ok", summary: "done" });
  const now = new Date();
  const k = readKpis(app.db, now, { ceilingUsd: null, idle: () => idleReason(app, now) });
  expect(k.builders.idle).toEqual({ word: "ceiling reached", href: "/meter" });
  expect(kpiLines(k, null)[3]).toBe("Builders running 0 of 1 · ceiling reached");
  expect(tile(String(kpiRowFor(k, null, now)))).toContain('href="/meter"');
  // Every slot busy: nothing is added, and the reason is not asked.
  claimRun(app.db, createRun(app.db, { repoId: repo.id, kind: "agent", actorId: builder.id, reason: "assigned" }).id);
  const busy = readKpis(app.db, now, { ceilingUsd: null, idle: () => { throw new Error("asked"); } });
  expect(busy.builders.idle).toBeNull();
});

test("a cached reason is dropped when the counts change: one of two slots running names no stale reason (#7664)", () => {
  const run = (id: string) => finishRun(app.db, id, { state: "ok", summary: "done" });
  for (const r of app.db.query<{ id: string }, []>("SELECT id FROM run WHERE kind = 'agent' AND state = 'running'").all()) run(r.id);
  app.db.query("UPDATE repo SET autonomy_slots = 2 WHERE autonomy != 'off'").run();
  kpiCache(app.db).clear();
  const now = new Date();
  const ceiling = { word: "ceiling reached", href: "/meter" };
  let reason: typeof ceiling | null = ceiling;
  const forge = { ceilingUsd: null, idle: () => reason };
  expect(cachedKpis(app.db, now, forge).builders).toEqual({ running: 0, slots: 2, idle: ceiling });
  // Same counts: the entry's reason is kept without asking.
  expect(cachedKpis(app.db, now, { ceilingUsd: null, idle: () => { throw new Error("asked"); } }).builders.idle).toEqual(ceiling);
  // One of two starts: the entry is still warm, but its reason was for 0 of 2.
  claimRun(app.db, createRun(app.db, { repoId: repo.id, kind: "agent", actorId: builder.id, reason: "assigned" }).id);
  reason = null;
  expect(cachedKpis(app.db, now, forge).builders).toEqual({ running: 1, slots: 2, idle: null });
});
