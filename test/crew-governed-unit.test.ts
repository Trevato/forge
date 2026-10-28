/**
 * `governorFor` and `announceGovernor` (src/crew/governed.ts) on their own:
 * the governor's slots read from the real vitals, one `crew.governed` event
 * per change of the governed number, the reason returned only while the
 * governor holds the crew below the operator's slots, and `repoPace` taking
 * the smaller of spend pacing's slots and the governor's. The picker itself
 * (runs started, the feed, the tick line) is proved in crew-governed.test.ts.
 * Each test has its own database, so none depends on another's pulls.
 */
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
import { announceGovernor, governorFor } from "../src/crew/governed.ts";
import { governedSlots } from "../src/crew/governor.ts";
import { readVitals } from "../src/flow/vitals.ts";
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
  /** A pull opened `openedH` hours before NOW; merged `mergedH` hours before it, when given. */
  const pull = (openedH: number, mergedH: number | null): void => {
    const issueId = id();
    n++;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7)`)
      .run(issueId, repo.id, n, `P${n}`, u.value.id, mergedH === null ? "open" : "closed", ago(openedH));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
      .run(issueId, repo.defaultBranch, `b/${n}`, repo.id, mergedH === null ? null : ago(mergedH));
  };
  const events = () =>
    app.db
      .query<{ payload: string }, [string]>(`SELECT payload FROM event WHERE kind = 'crew.governed' AND repo_id = ?1 ORDER BY rowid`)
      .all(repo.id)
      .map((e) => JSON.parse(e.payload) as { from: number; to: number; why: string });
  return { app, repo, pull, events, userId: u.value.id };
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

test("a pile lowers the slots: governorFor and the pace take the smaller, announce says it once", async () => {
  const { app, repo, pull, events } = await forge(4);
  for (let i = 0; i < 12; i++) pull(20 + i, null); // 12 open, none landed
  const vitals = readVitals(app.db, NOW);
  expect(vitals).toMatchObject({ open: 12, landed1h: 0 });
  const want = governedSlots(vitals, 4);
  expect(want.slots).toBeLessThan(4);

  const g = governorFor(app, repo, NOW);
  expect(g).toEqual(want);
  expect(g.why).toContain("12 open vs 0 landed");
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

  // A pile: the governor's 1 is now the smaller of the two.
  for (let i = 0; i < 12; i++) pull(20 + i, null);
  expect(governorFor(app, repo, NOW).slots).toBe(1);
  expect(repoPace(app, repo, NOW).slots).toBe(1);
});

test("the reason is absent when the governed number equals the operator's slots", async () => {
  const one = await forge(1);
  for (let i = 0; i < 12; i++) one.pull(20 + i, null);
  expect(governorFor(one.app, one.repo, NOW).slots).toBe(1);
  expect(announceGovernor(one.app, one.repo, NOW)).toBeUndefined();
  expect(one.events()).toEqual([]);
  const off = await forge(0);
  expect(announceGovernor(off.app, off.repo, NOW)).toBeUndefined();
  expect(off.events()).toEqual([]);
});

test("a recovery is a second change: one more event, then no reason", async () => {
  const { app, repo, pull, events } = await forge(4);
  for (let i = 0; i < 12; i++) pull(20 + i, null);
  expect(readVitals(app.db, NOW)).toMatchObject({ open: 12, landed1h: 0 });
  expect(announceGovernor(app, repo, NOW)).toBeDefined();
  const held = governorFor(app, repo, NOW).slots;
  expect(held).toBeLessThan(4);

  // Six more land in the last hour: 12 open is no more than 3 x 6 landed, and the hour's inflow is zero.
  for (let i = 0; i < 6; i++) pull(30 + i, 0.1);
  expect(readVitals(app.db, later(5))).toMatchObject({ open: 12, landed1h: 6, opened1h: 0 });
  expect(governorFor(app, repo, later(5)).slots).toBe(4);
  expect(announceGovernor(app, repo, later(5))).toBeUndefined();
  expect(announceGovernor(app, repo, later(6))).toBeUndefined();
  expect(events().map((e) => [e.from, e.to])).toEqual([[4, held], [held, 4]]);
});
