/** `usage` with no repo: the forge's spend, today and last24h named apart, and headroom per subscription. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { readForgeUsage } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { freePct, noteLimit } from "../src/core/standing.ts";
import { addSubscription, EVERYONE, setGrants } from "../src/core/subscriptions.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { tool } from "../src/http/mcp/tools/usage.ts";

let dir: string;
let app: App;
let alice: User;
let bob: User;
let carol: User;
let mine: Repo;
let theirs: Repo;
let subId: string;
let servers: Servers;
const now = new Date("2026-10-16T02:00:00Z");
const iso = (s: string) => new Date(s).toISOString();

function spend(runId: string, repo: Repo, at: string, costUsd: number, sub: string | null = subId) {
  recordUsage(app.db, {
    runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id, repoId: repo.id, issueId: null, agentId: null, subscriptionId: sub,
    tokensIn: 100, tokensOut: 10, costUsd, wallMs: 1000, outcome: "ok", at: iso(at),
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-usage-forge-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  alice = await mk("alice");
  bob = await mk("bob");
  promote(app.db, alice);
  promote(app.db, bob);
  const a = await createRepo(app, alice, { name: "mine", visibility: "public" });
  const b = await createRepo(app, bob, { name: "theirs", visibility: "public" });
  if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]).slice(0, 300));
  mine = a.value;
  theirs = b.value;
  const sub = addSubscription(app.db, dir, { name: "work", token: "sk-ant-api03-work-key-for-the-forge-test" });
  if (!sub.ok) throw new Error("sub");
  subId = sub.value.id;
  setGrants(app.db, mine.id, EVERYONE, [subId]);
  // 02:00 UTC now: 23:00 the day before is inside the last 24 h but not today.
  spend("r-today", mine, "2026-10-16T01:00:00Z", 1);
  spend("r-before-midnight", mine, "2026-10-15T23:00:00Z", 2);
  spend("r-two-days", mine, "2026-10-15T01:00:00Z", 4);
  spend("r-bobs", theirs, "2026-10-16T01:00:00Z", 50);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("today and last24h are named apart and differ across midnight", () => {
  const r = readForgeUsage(app, alice, now);
  expect(r.todaySince).toBe("2026-10-16T00:00:00.000Z");
  expect(r.last24hSince).toBe("2026-10-15T02:00:00.000Z");
  expect(r.today.costUsd).toBe(1);
  expect(r.last24h.costUsd).toBe(3);
  expect(r.last24h.runs).toBe(2);
});

test("a writer of one repository never sees another's spend", () => {
  const r = readForgeUsage(app, alice, now);
  expect(r.apps).toBe(1);
  expect(r.today.costUsd).toBe(1);
  expect(r.last24h.costUsd).toBe(3);
  expect(r.subscriptions.reduce((t, x) => t + x.last24h.costUsd, 0)).toBe(3);
  const b = readForgeUsage(app, bob, now);
  expect(b.last24h.costUsd).toBe(50);
  expect(readForgeUsage(app, undefined, now).last24h.runs).toBe(0);
});

test("each subscription carries headroom as a percent of its window limit", () => {
  const before = readForgeUsage(app, alice, now).subscriptions.find((s) => s.subscription === "work")!;
  expect(before.headroom.every((h) => h.pct === null)).toBe(true);
  noteLimit(app.db, subId, {
    window: "5h", resetsAt: iso("2026-10-16T05:00:00Z"), observedAt: iso("2026-10-16T01:30:00Z"), said: "limit",
  });
  const after = readForgeUsage(app, alice, now).subscriptions.find((s) => s.subscription === "work")!;
  const five = after.headroom.find((h) => h.window === "5h")!;
  expect(five.pct).toBe(0);
  expect(five.resetsAt).toBe("2026-10-16T05:00:00.000Z");
});

test("the tool answers without repo, and still asks for one when named wrongly", () => {
  const ok = tool.run({ app } as never, alice, {}) as { ok: true; value: any };
  expect(ok.ok).toBe(true);
  const body = ok.value;
  expect(body.apps).toBe(1);
  // The tool reads the real clock, long after the fixed spend: the shape is what it proves.
  expect(body.today).toEqual({ runs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  expect(body.last24h).toEqual(body.today);
  expect(body.todaySince).toMatch(/T00:00:00\.000Z$/);
  const work = body.subscriptions.find((s: { subscription: string }) => s.subscription === "work");
  expect(work.headroom.map((h: { window: string }) => h.window)).toContain("5h");
  expect(JSON.stringify(tool.run({ app } as never, alice, { repo: "nobody/none" }))).toContain("not_found");
});

test("the percent free rounds, clamps to 0–100 and is null without a cap", () => {
  expect(freePct(10, 2.5)).toBe(75);
  expect(freePct(3, 1)).toBe(67);
  expect(freePct(10, 25)).toBe(0);
  expect(freePct(10, -5)).toBe(100);
  expect(freePct(0, 1)).toBeNull();
  expect(freePct(null, 1)).toBeNull();
});

test("spend paid by a removed subscription stays in the totals as its own row", () => {
  spend("r-gone", mine, "2026-10-16T01:10:00Z", 7, "gone-subscription-id");
  const r = readForgeUsage(app, alice, now);
  expect(r.today.costUsd).toBe(8);
  expect(r.last24h.costUsd).toBe(10);
  const gone = r.subscriptions.find((s) => s.subscription === "a removed subscription")!;
  expect(gone.today.costUsd).toBe(7);
});

test("a site admin sees every app's spend", () => {
  const r = readForgeUsage(app, carol, now);
  expect(r.apps).toBe(2);
  expect(r.last24h.costUsd).toBe(60);
});

test("days without a repo is refused rather than ignored", () => {
  expect(JSON.stringify(tool.run({ app } as never, alice, { days: 3 }))).toContain("invalid_days");
});

test("GET /api/v1/usage answers the caller's apps and refuses a guest", async () => {
  const token = createToken(app.db, alice.id, "ro", "ro").token;
  const got = await fetch(`${servers.url}/api/v1/usage`, { headers: { authorization: `Bearer ${token}` } });
  expect(got.status).toBe(200);
  const body = (await got.json()) as { apps: number; today: unknown; last24h: unknown };
  expect(body.apps).toBe(1);
  expect(body).toHaveProperty("today");
  expect((await fetch(`${servers.url}/api/v1/usage`)).status).toBe(401);
});

test("an admin reads every visible app past one page, never a capped count", async () => {
  for (let i = 0; i < 205; i++) {
    const r = await createRepo(app, bob, { name: `bulk-${i}`, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
  }
  expect(readForgeUsage(app, carol, now).apps).toBe(207);
}, 120_000);
