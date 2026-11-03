/** The week is one budget for the whole crew, not one per repository (#8989). */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit, setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { insertBet, markBacked } from "../src/core/bets.ts";
import { byBackedBets, repoPace } from "../src/crew/autonomy.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { forgetStagger, offsetOf, SPREAD_MS, staggeredUntil } from "../src/crew/ceiling_stagger.ts";
import { forgetWeek, weekWords } from "../src/crew/week_read.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
let dir: string;
let app: App;
let alice: User;
let repos: Repo[] = [];
let sub: string;

function spend(repo: Repo, usd: number, at: Date): void {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent" });
  app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(run.id);
  recordUsage(app.db, { runId: run.id, repoId: repo.id, issueId: null, agentId: null, subscriptionId: sub, tokensIn: 1, tokensOut: 1, costUsd: usd, wallMs: 1000, outcome: "ok", at: at.toISOString() });
}

/** The measured readings: 44% free an hour ago, 42% now (about 2 points in the hour, against about 0.4 allowed). */
function measured(): void {
  app.db.query("DELETE FROM usage").run();
  app.db.query("DELETE FROM week_reading").run();
  spend(repos[0]!, 100, new Date(NOW.getTime() - 4 * DAY));
  noteLimit(app.db, sub, { window: "week", resetsAt: new Date(NOW.getTime() - 3.5 * DAY).toISOString(), observedAt: new Date(NOW.getTime() - 3.5 * DAY - 3_600_000).toISOString(), said: "weekly limit" });
  spend(repos[0]!, 56, new Date(NOW.getTime() - DAY));
  spend(repos[0]!, 2, new Date(NOW.getTime() - 3_600_000));
  app.db.query("INSERT INTO week_reading (scope, at, free_pct) VALUES (?1, ?2, 44)").run(sub, new Date(NOW.getTime() - 3_600_000).toISOString());
  forgetWeek();
}

function running(repo: Repo, n: number): void {
  const bot = getUserByName(app.db, "builderbot")!;
  for (let i = 0; i < n; i++) {
    const r = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: bot.id });
    app.db.query("UPDATE run SET state = 'running' WHERE id = ?1").run(r.id);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-crew-week-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const bot = await createAgent(app, alice, { username: "builderbot" });
  if (!bot.ok) throw new Error(String(bot.error));
  const added = addSubscription(app.db, dir, { name: "main", token: "sk-ant-oat01-crew-week-1" });
  if (!added.ok) throw new Error(added.error);
  sub = added.value.id;
  setHeadroom(app.db, sub, 0);
  for (const name of ["a", "b", "c", "d"]) {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, made.value, "builderbot").ok).toBe(true);
    const on = await updateRepoSettings(app, alice, made.value, { autonomy: "autonomous", autonomyDirection: "Ship it.", autonomyCeilingUsd: 1000, autonomySlots: 5, autonomyBy: alice.id });
    expect(on.ok).toBe(true);
    app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(made.value.id, sub);
    repos.push(getRepoById(app.db, made.value.id)!);
  }
  setCapacity(app.db, "crew.concurrency", "10", alice.id);
});

beforeEach(() => {
  app.db.query("DELETE FROM run WHERE state IN ('queued','running')").run();
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the readings of 2026-11-03 slow the total: the whole crew holds at the floor, not each repository", () => {
  measured();
  const slots = repos.map((r) => repoPace(app, r, NOW).slots);
  // Nothing running: each repository may start, but only to the crew's budget between them.
  expect(Math.max(...slots)).toBe(2);
  running(repos[0]!, 2);
  const after = repos.map((r) => repoPace(app, r, NOW).slots);
  expect(after).toEqual([2, 0, 0, 0]);
  expect(repoPace(app, repos[1]!, NOW).reason).toContain("whole crew has 2");
});

test("a repository's own slots stay limits inside the crew's budget", () => {
  measured();
  app.db.query("UPDATE repo SET autonomy_slots = 1 WHERE id = ?1").run(repos[2]!.id);
  expect(repoPace(app, getRepoById(app.db, repos[2]!.id)!, NOW).slots).toBe(1);
  app.db.query("UPDATE repo SET autonomy_slots = 5 WHERE id = ?1").run(repos[2]!.id);
});

test("finishing work is not held by the crew's budget, only new picks are", () => {
  measured();
  running(repos[0]!, 2);
  expect(repoPace(app, repos[1]!, NOW).slots).toBe(0);
  expect(repoPace(app, repos[1]!, NOW, false).slots).toBeGreaterThan(0);
});

test("home says the whole crew's number", () => {
  measured();
  expect(weekWords(app, NOW)).toContain("The week allows the whole crew 2 of 10 slots across every repository.");
});

test("a repository that hit its ceiling yesterday restarts at its own time, spread over the morning", () => {
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 5, 0));
  for (const r of repos) {
    const run = createRun(app.db, { repoId: r.id, kind: "agent" });
    app.db.query("UPDATE run SET cost_usd = 1000, created_at = ?2, state = 'ok' WHERE id = ?1").run(run.id, new Date(Date.UTC(2026, 10, 2, 20, 0, 0)).toISOString());
  }
  const ready = repos.map((r) => staggeredUntil(app.db, r, midnight)?.getTime() ?? 0);
  expect(new Set(ready).size).toBeGreaterThan(1);
  for (const at of ready) expect(at).toBeLessThan(Date.UTC(2026, 10, 3) + SPREAD_MS);
  for (const r of repos) {
    expect(offsetOf(r.id)).toBeGreaterThanOrEqual(0);
    expect(offsetOf(r.id)).toBeLessThan(SPREAD_MS);
  }
  // FNV-1a of "a" is fixed, so the offsets cannot drift between releases and move every repository's restart.
  expect(offsetOf("a")).toBe(2_802_220);
  expect(repoPace(app, repos[0]!, midnight, true).slots).toBe(0);
  // Past the spread nothing waits.
  expect(staggeredUntil(app.db, repos[0]!, new Date(Date.UTC(2026, 10, 3, 7)))).toBeNull();
  // A repository that did not hit its ceiling is never held.
  app.db.query("DELETE FROM run WHERE repo_id = ?1").run(repos[3]!.id);
  forgetStagger();
  expect(staggeredUntil(app.db, repos[3]!, midnight)).toBeNull();
});

test("a ceiling of 0 allows no spend and is held by the ceiling, so it is never also held until an offset", () => {
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 5, 0));
  forgetStagger();
  expect(staggeredUntil(app.db, { id: repos[0]!.id, autonomyCeilingUsd: 0 }, midnight)).toBeNull();
});

test("the stagger reads yesterday's spend once for one instant", () => {
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 5, 0));
  const run = createRun(app.db, { repoId: repos[3]!.id, kind: "agent" });
  app.db.query("UPDATE run SET cost_usd = 1000, created_at = ?2, state = 'ok' WHERE id = ?1").run(run.id, new Date(Date.UTC(2026, 10, 2, 20, 0, 0)).toISOString());
  forgetStagger();
  const first = staggeredUntil(app.db, repos[3]!, midnight);
  expect(first).not.toBeNull();
  app.db.query("DELETE FROM run WHERE id = ?1").run(run.id);
  expect(staggeredUntil(app.db, repos[3]!, midnight)).toEqual(first);
  forgetStagger();
  expect(staggeredUntil(app.db, repos[3]!, midnight)).toBeNull();
});

test("picks made earlier in this tick in other repositories count against the crew's budget", () => {
  app.db.query("DELETE FROM run").run();
  measured();
  const picked = new Map<string, Set<string>>([[repos[0]!.id, new Set(["issue-x", "issue-y"])]]);
  expect(repoPace(app, repos[1]!, NOW).slots).toBe(2);
  expect(repoPace(app, repos[1]!, NOW, true, picked).slots).toBe(0);
  // Finishing work is not held by them.
  expect(repoPace(app, repos[1]!, NOW, false, picked).slots).toBeGreaterThan(0);
});

test("repositories with a backed bet are driven first, the rest in their order", () => {
  const bet = insertBet(app.db, { repoId: repos[3]!.id, name: "Search", journeys: "", appetite: 5, leadId: null, issueIds: [] }, NOW);
  markBacked(app.db, bet.id, 5, "owner", NOW);
  const order = byBackedBets(app.db, repos).map((r) => r.name);
  expect(order).toEqual(["d", "a", "b", "c"]);
  app.db.query("DELETE FROM bet WHERE id = ?1").run(bet.id);
  expect(byBackedBets(app.db, repos).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
});

test("the terminal's home prints the crew's number", async () => {
  measured();
  const terminal = headlessTerminal(300, 32);
  const { app: tui } = createForgeApp(app, { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice }, { terminal, exitHooks: false });
  tui.start();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop();
  expect(text).toContain("whole crew");
});
