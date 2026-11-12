/**
 * `governorFor` and `announceGovernor` (src/crew/governed.ts) on their own:
 * the governor's slots read from the repository's own flow (#7644), one `crew.governed` event
 * per change of the governed number, the reason returned only while the
 * governor holds the crew below the operator's slots, and `repoPace` taking
 * the smaller of spend pacing's slots and the governor's. The picker itself
 * (runs started, the feed, the tick line) is proved in crew-governed.test.ts.
 * Each test has its own database, so none depends on another's pulls.
 */
import { quietWeek } from "./helpers/week-quiet.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit, setHeadroom } from "../src/core/standing.ts";
import { addSubscription, setGrants } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser } from "../src/core/users.ts";
import { repoPace } from "../src/crew/autonomy.ts";
import { announceGovernor, governorFor, governorLine, governorSeen } from "../src/crew/governed.ts";
import { governedSlots } from "../src/crew/governor.ts";
import { readRepoFlow } from "../src/flow/repo_flow.ts";
import { id } from "../src/kernel/id.ts";

const NOW = new Date("2026-10-02T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

/** A fresh forge with one repository whose operator's slots are `slots`. */
async function forge(slots: number) {
  const root = mkdtempSync(join(tmpdir(), "forge-governed-unit-"));
  const app: App = createApp({ dataDir: root, port: 0 });
  quietWeek(app.db);
  cleanup.push(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const u = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const r = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "gov", visibility: "public", description: "g" });
  if (!r.ok) throw new Error(r.error);
  const repo: Repo = { ...r.value, autonomySlots: slots };
  let n = 0;
  /**
   * A pull opened (and last touched) `openedH` hours before NOW, negative for
   * after it; merged `mergedH` hours before NOW, when given. Returns its issue id.
   */
  const pull = (openedH: number, mergedH: number | null): string => {
    const issueId = id();
    n++;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7, ?7)`)
      .run(issueId, repo.id, n, `P${n}`, u.value.id, mergedH === null ? "open" : "closed", ago(openedH));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', 'head', ?4, ?5)`)
      .run(issueId, repo.defaultBranch, `b/${n}`, repo.id, mergedH === null ? null : ago(mergedH));
    return issueId;
  };
  const events = () =>
    app.db
      .query<{ payload: string }, [string]>(`SELECT payload FROM event WHERE kind = 'crew.governed' AND repo_id = ?1 ORDER BY rowid`)
      .all(repo.id)
      .map((e) => JSON.parse(e.payload) as { from: number; to: number; why: string });
  /** Lands the pull `issueId` `mergedH` hours before NOW. */
  const land = (issueId: string, mergedH: number): void => {
    app.db.query(`UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1`).run(issueId, ago(mergedH));
    app.db.query(`UPDATE issue SET state = 'closed' WHERE id = ?1`).run(issueId);
  };
  /** A run on the pull `issueId`, started `atH` hours before NOW. */
  const run = (issueId: string, kind: "check" | "agent", state: "ok" | "failed", atH: number, commit = "head"): void => {
    app.db
      .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .run(id(), repo.id, kind, issueId, commit, state, ago(atH));
  };
  return { app, repo, pull, land, run, events, user: u.value, userId: u.value.id };
}

const later = (s: number) => new Date(NOW.getTime() + s * 1000);

test("a quiet forge answers the operator's slots, says nothing, and the pace follows", async () => {
  const { app, repo, events } = await forge(5);
  const g = governorFor(app, repo, NOW);
  expect(g.slots).toBe(5);
  expect(g.why).toContain("Builders 5");
  expect(announceGovernor(app, repo, NOW)).toBeUndefined();
  expect(events()).toEqual([]);
  expect(repoPace(app, repo, NOW).slots).toBe(5);
});

/** 12 pulls opened within the last hour, none landed: a flood. */
const flood = (pull: (openedH: number, mergedH: number | null) => string): string[] =>
  Array.from({ length: 12 }, (_, i) => pull(0.1 + i * 0.05, null));

test("a flood lowers the slots: governorFor and the pace take the smaller, announce says it once", async () => {
  const { app, repo, pull, events } = await forge(4);
  flood(pull);
  const flow = readRepoFlow(app.db, repo.id, NOW);
  expect(flow).toMatchObject({ open: 12, moving: 12, opened1h: 12, landed1h: 0 });
  const want = governedSlots(flow, 4);
  expect(want.slots).toBeLessThan(4);

  const g = governorFor(app, repo, NOW);
  expect(g).toEqual(want);
  expect(g.why).toContain("12 opened vs 0 landed");
  // No subscription accounts: spend pacing allows all 4, so the governor's is the smaller.
  expect(repoPace(app, repo, NOW).slots).toBe(g.slots);

  expect(announceGovernor(app, repo, NOW)).toBe(g.why);
  expect(announceGovernor(app, repo, later(1))).toBe(g.why);
  expect(announceGovernor(app, repo, later(2))).toBe(g.why);
  expect(events()).toEqual([{ from: 4, to: g.slots, why: g.why }]);
});

test("spend pacing is the smaller when the windows are nearly spent, the governor when the pile is", async () => {
  const { app, repo, pull, userId } = await forge(5);
  const added = addSubscription(app.db, app.config.dataDir, { name: "acct", token: "sk-ant-oat01-governed-test" });
  if (!added.ok) throw new Error(added.error);
  const sub = added.value.id;
  setGrants(app.db, repo.id, userId, [sub]);
  expect(setHeadroom(app.db, sub, 0)).toBe(true);
  const spend = (start: string, usd: number): void => {
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id,
      repoId: repo.id, issueId: null, agentId: null, subscriptionId: sub,
      tokensIn: 1000, tokensOut: 100, costUsd: usd, wallMs: 60_000, outcome: "ok",
      at: new Date(Date.parse(start) + 60_000).toISOString(),
    });
  };
  // The provider refused at a $5 cap in the window 09:00–14:00; a run for $3 in the next window leaves $2.
  spend("2026-10-02T09:30:00Z", 5);
  noteLimit(app.db, sub, { window: "5h", resetsAt: "2026-10-02T14:00:00.000Z", observedAt: "2026-10-02T11:00:00.000Z", said: "You've hit your session limit · resets 2pm (UTC)" });
  spend("2026-10-02T14:30:00Z", 3);

  // Quiet forge: the governor allows 5, spend pacing allows 2; the pace is spend's.
  expect(governorFor(app, repo, NOW).slots).toBe(5);
  const paced = repoPace(app, repo, NOW);
  expect(paced.slots).toBe(2);
  expect(paced.reason).toContain("windows are filling");
  // The reason the tick line carries is the governor's, and it holds nothing back here.
  expect(announceGovernor(app, repo, NOW)).toBeUndefined();

  // A flood: the governor's 1 is now the smaller of the two.
  flood(pull);
  expect(governorFor(app, repo, NOW).slots).toBe(1);
  expect(repoPace(app, repo, NOW).slots).toBe(1);
});

test("the reason is absent when the governed number equals the operator's slots", async () => {
  const one = await forge(1);
  flood(one.pull);
  expect(governorFor(one.app, one.repo, NOW).slots).toBe(1);
  expect(announceGovernor(one.app, one.repo, NOW)).toBeUndefined();
  expect(one.events()).toEqual([]);
  const off = await forge(0);
  expect(announceGovernor(off.app, off.repo, NOW)).toBeUndefined();
  expect(off.events()).toEqual([]);
});

test("a recovery is a second change: one more event, then no reason", async () => {
  const { app, repo, pull, events } = await forge(4);
  flood(pull);
  expect(readRepoFlow(app.db, repo.id, NOW)).toMatchObject({ open: 12, landed1h: 0 });
  expect(announceGovernor(app, repo, NOW)).toBeDefined();
  const held = governorFor(app, repo, NOW).slots;
  expect(held).toBeLessThan(4);

  // Six more land in the last hour: 12 moving is no more than 3 x 6 landed, and 6 h opened only 6 more than landed.
  for (let i = 0; i < 6; i++) pull(30 + i, 0.1);
  expect(readRepoFlow(app.db, repo.id, later(5))).toMatchObject({ open: 12, landed1h: 6, opened1h: 12 });
  expect(governorFor(app, repo, later(5)).slots).toBe(4);
  expect(announceGovernor(app, repo, later(5))).toBeUndefined();
  expect(announceGovernor(app, repo, later(6))).toBeUndefined();
  expect(events().map((e) => [e.from, e.to])).toEqual([[4, held], [held, 4]]);
});

test("a stale pile, a red pull and another repository's flood do not hold the builders (#7644)", async () => {
  const { app, repo, pull, userId } = await forge(5);
  // 2026-11-01: 55 open, untouched for a day and more; nothing opened or landed this hour.
  for (let i = 0; i < 55; i++) pull(30 + i, null);
  // One fresh pull whose check on its head is red: open, not moving.
  pull(0.5, null);
  const red = app.db.query<{ id: string }, [string]>(`SELECT id FROM issue WHERE repo_id = ?1 ORDER BY created_at DESC LIMIT 1`).get(repo.id)!.id;
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, created_at) VALUES (?1, ?2, 'check', ?3, 'head', 'failed', ?4)`)
    .run(id(), repo.id, red, ago(0.4));
  // A flood in another repository: 30 opened this hour, none landed.
  const other = await createRepo(app.db, app.reposRoot, { ownerId: userId, name: "other", visibility: "public", description: "o" });
  if (!other.ok) throw new Error(other.error);
  for (let i = 0; i < 30; i++) {
    const issueId = id();
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'o', '', ?4, 'open', ?5)`)
      .run(issueId, other.value.id, i + 1, userId, ago(0.2));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', '', ?3)`)
      .run(issueId, `o/${i}`, other.value.id);
  }
  expect(readRepoFlow(app.db, repo.id, NOW)).toEqual({ open: 56, moving: 0, opened1h: 1, landed1h: 0, opened6h: 1, landed6h: 0 });
  const g = governorFor(app, repo, NOW);
  expect(g.slots).toBe(5);
  expect(g.why).toBe("Builders 5: 1 opened, 0 landed last hour, 0 of 56 open pulls moving");
});

test("a quiet hour over a moving pile does not lower the slots", async () => {
  const { app, repo, pull } = await forge(5);
  for (let i = 0; i < 20; i++) pull(2 + i * 0.1, null); // opened 2–4 h ago: moving, nothing this hour
  expect(readRepoFlow(app.db, repo.id, NOW)).toMatchObject({ moving: 20, opened1h: 0, landed1h: 0 });
  expect(governorFor(app, repo, NOW)).toEqual({ slots: 5, why: "Builders 5: a quiet hour, 20 of 20 open pulls moving" });
});

test("the latest check on the head says whether a pull moves; a red check on an older head does not count", async () => {
  const { app, repo, pull, run } = await forge(5);
  const p = pull(0.5, null);
  const moving = () => readRepoFlow(app.db, repo.id, NOW).moving;
  expect(moving()).toBe(1);
  run(p, "check", "failed", 0.4);
  expect(moving()).toBe(0);
  run(p, "check", "ok", 0.3); // a newer green check on the same head wins
  expect(moving()).toBe(1);
  run(p, "check", "failed", 0.2, "older-head"); // red, but not on this head
  expect(moving()).toBe(1);
  run(p, "check", "failed", 0.1); // red again, latest
  expect(moving()).toBe(0);
});

test("a pull untouched for a day moves again only when a run touches it within the day", async () => {
  const { app, repo, pull, run } = await forge(5);
  const p = pull(30, null);
  const moving = () => readRepoFlow(app.db, repo.id, NOW).moving;
  expect(moving()).toBe(0);
  run(p, "agent", "ok", 26); // a run, but older than the day
  expect(moving()).toBe(0);
  run(p, "agent", "ok", 2);
  expect(moving()).toBe(1);
  expect(readRepoFlow(app.db, repo.id, NOW).open).toBe(1);
});

test("from 1 builder after a flood, over a stale pile and a young backlog, the slots climb back and stay (#7644, #7712)", async () => {
  const { app, repo, pull, land } = await forge(5);
  // 45 pulls nobody works: opened and last touched two days and more ago.
  for (let i = 0; i < 45; i++) pull(48 + i, null);
  // A young backlog of 10, opened 2–3 h ago, moving, and never landed: the pile the ramp opens over.
  for (let i = 0; i < 10; i++) pull(2 + i * 0.1, null);
  // Hour 0: a flood of 12 opened, none landed: the governor holds the crew at 1.
  let lastHour = flood(pull);
  let slots = governorFor(app, repo, NOW).slots;
  expect(slots).toBe(1);
  const seen: number[] = [];
  // Each later hour the builders open one pull per slot and land what the hour before opened.
  for (let hour = 1; hour <= 8; hour++) {
    for (const p of lastHour) land(p, 0.25 - hour);
    lastHour = Array.from({ length: slots }, (_, i) => pull(0.5 - hour + i * 0.01, null));
    const at = new Date(NOW.getTime() + hour * 3_600_000);
    const flow = readRepoFlow(app.db, repo.id, at);
    expect(flow.open).toBeGreaterThanOrEqual(55);
    expect(flow.moving).toBeGreaterThanOrEqual(10);
    expect(flow.opened1h).toBe(slots);
    slots = governorFor(app, repo, at).slots;
    seen.push(slots);
  }
  expect(seen).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
});

test("governorSeen gates the governor alike for every door: off crew or a reader who cannot write sees none", async () => {
  const { app, repo, pull, user } = await forge(4);
  flood(pull);
  expect(governorSeen(app, user, repo, NOW)).toBeUndefined(); // autonomy off
  const on: Repo = { ...repo, autonomy: "assisted" };
  const seen = governorSeen(app, user, on, NOW);
  expect(seen).toEqual({ ...governorFor(app, on, NOW), ceiling: 4, held: true, says: "" });
  expect(governorSeen(app, undefined, on, NOW)).toBeUndefined();
});

test("announceGovernor remembers a change: governorSeen says it after, and nothing before (#11459)", async () => {
  const { app, repo: r0, pull } = await forge(4);
  const repo = { ...r0, autonomy: "assisted" as const };
  const actor = app.db.query<any, []>("SELECT * FROM user LIMIT 1").get();
  const user = (await import("../src/core/users.ts")).getUserById(app.db, actor.id)!;
  expect(announceGovernor(app, repo, NOW)).toBeUndefined(); // baseline
  expect(governorSeen(app, user, repo, NOW)!.says).toBe("");
  flood(pull);
  announceGovernor(app, repo, later(1));
  const seenNow = governorSeen(app, user, repo, later(1))!;
  expect(seenNow.says).toStartWith("Builders 4 → ");
  expect(seenNow.says).toContain(seenNow.why);
  expect(governorLine(seenNow)).toBe(seenNow.says);
});

test("deleting a repository forgets its governor line (#11459)", async () => {
  const { app, repo, pull } = await forge(4);
  announceGovernor(app, repo, NOW);
  flood(pull);
  announceGovernor(app, repo, later(1));
  expect(app.db.query("SELECT 1 FROM governor_last WHERE repo_id = ?1").get(repo.id)).not.toBeNull();
  await (await import("../src/core/repos.ts")).deleteRepo(app.db, app.reposRoot, repo);
  expect(app.db.query("SELECT 1 FROM governor_last WHERE repo_id = ?1").get(repo.id)).toBeNull();
});
