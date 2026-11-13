/** What the crew's repositories share: their own slots, the midnight spread and the bets' order (#8989). */
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
import { setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { type User } from "../src/core/users.ts";
import { insertBet, markBacked } from "../src/core/bets.ts";
import { byBackedBets, repoPace } from "../src/crew/autonomy.ts";
import { forgetStagger, offsetOf, SPREAD_MS, staggeredUntil } from "../src/crew/ceiling_stagger.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const NOW = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
let dir: string;
let app: App;
let alice: User;
let repos: Repo[] = [];
let sub: string;

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

test("a repository's own slots are its limit", () => {
  app.db.query("UPDATE repo SET autonomy_slots = 1 WHERE id = ?1").run(repos[2]!.id);
  expect(repoPace(app, getRepoById(app.db, repos[2]!.id)!, NOW).slots).toBe(1);
  app.db.query("UPDATE repo SET autonomy_slots = 5 WHERE id = ?1").run(repos[2]!.id);
});

test("a repository that hit its ceiling yesterday restarts at its own time, spread over the morning", () => {
  // Midnight itself: repository ids are random, so an instant past 00:00 would
  // find a repository whose offset has already come and nothing held.
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 0, 0));
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
  // Midnight itself: repository ids are random, so an instant past 00:00 would
  // find a repository whose offset has already come and nothing held.
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 0, 0));
  forgetStagger();
  expect(staggeredUntil(app.db, { id: repos[0]!.id, autonomyCeilingUsd: 0 }, midnight)).toBeNull();
});

test("the stagger reads yesterday's spend once for one instant", () => {
  // Midnight itself: repository ids are random, so an instant past 00:00 would
  // find a repository whose offset has already come and nothing held.
  const midnight = new Date(Date.UTC(2026, 10, 3, 0, 0, 0));
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

test("repositories with a backed bet are driven first, the rest in their order", () => {
  const bet = insertBet(app.db, { repoId: repos[3]!.id, name: "Search", journeys: "", appetite: 5, leadId: null, issueIds: [] }, NOW);
  markBacked(app.db, bet.id, 5, "owner", NOW);
  const order = byBackedBets(app.db, repos).map((r) => r.name);
  expect(order).toEqual(["d", "a", "b", "c"]);
  app.db.query("DELETE FROM bet WHERE id = ?1").run(bet.id);
  expect(byBackedBets(app.db, repos).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
});
