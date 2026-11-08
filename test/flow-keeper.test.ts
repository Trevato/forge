/** The throughput keeper (#7645): it names what binds landings, unsticks what is its to unstick, checks, undoes, and files once. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { readScorecards } from "../src/actions/scorecard.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription, EVERYONE, setGrants } from "../src/core/subscriptions.ts";
import type { User } from "../src/core/users.ts";
import { isLow, keeperDays, readRate, type Rate } from "../src/flow/keeper_rate.ts";
import { createUser } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { flowLines, flowScreen } from "../src/tui/screens/flow.ts";
import { scorecardScreen } from "../src/tui/screens/scorecard.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { answerKeeper, EFFECT_MS, listAttempts, readKeeper, tickKeeper } from "../src/flow/keeper.ts";
import { pickCause, type KeeperFacts, type RepoFacts } from "../src/flow/keeper_cause.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let repo: Repo;
let was: string | undefined;
const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const cookie = (): Record<string, string> => ({ cookie: `forge_session=${createSession(app.db, admin.id).token}; forge_mode=studio` });
const filed = (): number => listAttempts(app.db, 50).filter((a) => a.outcome === "filed").length;

beforeAll(async () => {
  was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "alice/engine";
  dir = await mkdtemp(join(tmpdir(), "forge-keeper-"));
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
  const on = await updateRepoSettings(app, admin, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Build.",
    autonomyCeilingUsd: 10,
    autonomySlots: 2,
    autonomyBy: admin.id,
  });
  expect(on.ok).toBe(true);
}, 60_000);

afterAll(async () => {
  if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = was;
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("2026-11-01: ready issues wait and no builder runs: it names the cause and unsticks", async () => {
  for (let n = 1; n <= 55; n++) {
    const o = openIssue(app, admin, fresh(), { title: `Work ${n}` });
    if (!o.ok) throw new Error(String(o.error));
  }
  let swept = 0;
  const now = new Date();
  const tick = tickKeeper(app, now, () => void (swept += 1));
  expect(tick).toEqual({ cause: "unassigned", acted: "unstick" });
  expect(swept).toBe(1);
  const read = readKeeper(app.db, true);
  expect(read.cause).toContain("55 ready issues in alice/engine and no builder is running");
  expect(read.last).toContain("unstuck assigned issues");
  // Not again while its check is pending.
  expect(tickKeeper(app, new Date(now.getTime() + 60_000), () => void (swept += 1)).acted).toBeNull();
  expect(swept).toBe(1);
});

test("the cause and last act show on the boards panel and the MCP flow report, not on home (#8015)", async () => {
  const home = await (await fetch(`${servers.url}/`, { headers: cookie() })).text();
  expect(home).not.toContain('id="keeper"');
  const boards = await (await fetch(`${servers.url}/boards`, { headers: cookie() })).text();
  expect(boards).toContain("unstuck assigned issues");
  expect(boards).toContain('id="keeper"');
  expect(boards).toContain("Binding landings:");
  const report = flowFor(app, { kind: "owner" });
  expect(report.keeper.cause).toContain("no builder is running");
  expect(report.keeper.last).toContain("unstuck assigned issues");
});

test("no rise in landings after the check time: the act is undone and the next tick does not try it again", () => {
  const later = new Date(Date.now() + EFFECT_MS + 60_000);
  tickKeeper(app, later);
  expect(listAttempts(app.db).map((a) => a.outcome)).toEqual(["undone"]);
  expect(readKeeper(app.db, true).ask).toBeNull();
  expect(tickKeeper(app, new Date(later.getTime() + 60_000)).acted).toBeNull();
});

test("a rise in landings keeps the act", async () => {
  app.db.query("DELETE FROM keeper_attempt").run();
  const t = new Date(Date.now() + 10 * EFFECT_MS);
  expect(tickKeeper(app, t, () => {}).acted).toBe("unstick");
  const issue = openIssue(app, admin, fresh(), { title: "Landed" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, 'b/1', '', '', ?3, ?4)`)
    .run(issue.value.id, fresh().defaultBranch, repo.id, new Date(t.getTime() + 30 * 60_000).toISOString());
  tickKeeper(app, new Date(t.getTime() + EFFECT_MS + 1000));
  expect(listAttempts(app.db).some((a) => a.action === "unstick" && a.outcome === "worked")).toBe(true);
});

test("a cause it cannot act on is filed once, not once per tick", () => {
  const before = filed();
  // Nothing is ready any more: every open issue is closed.
  app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1").run(repo.id);
  const t = Date.now() + 100 * EFFECT_MS;
  for (let i = 0; i < 4; i++) tickKeeper(app, new Date(t + i * 60_000));
  expect(filed()).toBe(before + 1);
  const issues = app.db.query<{ title: string }, []>("SELECT title FROM issue WHERE title LIKE 'Throughput:%'").all();
  expect(issues.length).toBe(1);
  expect(issues[0]!.title).toContain("Nothing is ready");
});

test("usage is the limit: it says when it resets, and spends nothing to say it", () => {
  const sub = addSubscription(app.db, dir, { name: "espo", token: "sk-ant-oat01-" + "x".repeat(24) });
  if (!sub.ok) throw new Error(sub.error);
  setGrants(app.db, repo.id, EVERYONE, [sub.value.id]);
  const now = Date.now() + 200 * EFFECT_MS;
  const resets = new Date(now + 3_600_000);
  noteLimit(app.db, sub.value.id, { window: "5h", resetsAt: resets.toISOString(), observedAt: new Date(now).toISOString(), said: "limit" });
  app.db.query("UPDATE issue SET state = 'open' WHERE repo_id = ?1 AND title = 'Work 1'").run(repo.id);
  const tick = tickKeeper(app, new Date(now));
  expect(tick).toEqual({ cause: "usage", acted: null });
  expect(readKeeper(app.db, true).cause).toBe(`Usage is the limit: no subscription has headroom, resets at ${resets.toISOString().slice(11, 16)} UTC.`);
});

test("the closed list: the ceiling outranks usage, and a tried cause gives way to the next", () => {
  const repoFacts: RepoFacts = {
    repoId: "r", slug: "a/b", startable: 2, running: 0, slots: 1,
    ceilingUsd: 10, atCeiling: true, noHeadroom: true, resetsAt: null,
  };
  const facts: KeeperFacts = { repos: [repoFacts], red: 0, stale: 0 };
  expect(pickCause(facts)?.cause).toBe("ceiling");
  expect(pickCause(facts, new Set(["ceiling"]))?.cause).toBe("usage");
  const open = repoFacts;
  expect(pickCause({ repos: [open], red: 0, stale: 0 })?.cause).toBe("ceiling");
  expect(pickCause({ repos: [open], red: 0, stale: 0 }, new Set(["ceiling"]))?.cause).toBe("usage");
  expect(pickCause({ repos: [{ ...repoFacts, atCeiling: false, noHeadroom: false }], red: 0, stale: 0 })?.cause).toBe("unassigned");
  expect(pickCause({ repos: [], red: 6, stale: 0 })).toBeNull();
});

test("the scorecard carries hours running and landed per day for a week", () => {
  const card = readScorecards(app, admin);
  expect(card?.keeperDays.length).toBe(7);
  const before = card!.keeperDays.reduce((n, d) => n + d.landed, 0);
  const issue = openIssue(app, admin, fresh(), { title: "Landed a minute ago" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, 'b/recent', '', '', ?3, ?4)`)
    .run(issue.value.id, fresh().defaultBranch, repo.id, new Date(Date.now() - 5 * 60_000).toISOString());
  const after = readScorecards(app, admin)!.keeperDays;
  expect(after.reduce((n, d) => n + d.landed, 0)).toBe(before + 1);
  expect(card!.keeperDays.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.day))).toBe(true);
});

const post = (headers: Record<string, string>, body: string) =>
  fetch(`${servers.url}/flow/keeper/answer`, {
    method: "POST",
    headers: { origin: servers.url, "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
    redirect: "manual",
  });
const ask = (): number => {
  app.db.query("DELETE FROM keeper_attempt").run();
  return Number(
    app.db
      .query("INSERT INTO keeper_attempt (at, cause, action, repo_id, says, outcome, check_at) VALUES (?1, 'unassigned', 'unstick', ?2, 'Unsticking did not help. Leave it?', 'asked', 0)")
      .run(Date.now(), repo.id).lastInsertRowid,
  );
};

test("a guest, a non-admin and an agent never read a private repository's name from the keeper", async () => {
  ask();
  app.db.query("DELETE FROM keeper_state").run();
  app.db
    .query("INSERT INTO keeper_state (id, cause, says, at) VALUES (1, 'unassigned', '55 ready issues in alice/engine and no builder is running.', ?1)")
    .run(Date.now());
  const guest = await (await fetch(`${servers.url}/boards`, { redirect: "follow" })).text();
  expect(guest).not.toContain("alice/engine");
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.test", password: "a-long-passphrase" });
  if (!bob.ok) throw new Error("bob");
  const bobCookie = { cookie: `forge_session=${createSession(app.db, bob.value.id).token}` };
  for (const path of ["/boards", "/"]) {
    const page = await (await fetch(`${servers.url}${path}`, { headers: bobCookie })).text();
    expect(page).not.toContain("alice/engine");
    expect(page).not.toContain('id="keeper-ask"');
  }
  const agentRead = flowFor(app, { kind: "agent" }).keeper;
  expect(agentRead.cause).not.toBeNull();
  expect(JSON.stringify(agentRead)).not.toContain("alice/engine");
  expect(agentRead.ask).toBeNull();
  const owner = flowFor(app, { kind: "owner" }).keeper;
  expect(owner.cause).toContain("alice/engine");
  expect(owner.ask).not.toBeNull();
});

test("POST /flow/keeper/answer: a guest signs in first, a non-admin is refused, a bad or stale id says it is gone", async () => {
  const id = ask();
  const guest = await post({}, `id=${id}`);
  expect(guest.status).toBe(303);
  expect(guest.headers.get("location")).toContain("sign");
  const bobCookie = {
    cookie: `forge_session=${createSession(app.db, app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'bob'").get()!.id).token}`,
  };
  expect((await post(bobCookie, `id=${id}`)).status).toBe(403);
  for (const body of ["id=0", "id=abc", "id=", "", `id=${id + 1000}`]) {
    const gone = await post(cookie(), body);
    expect(gone.status).toBe(303);
    expect(gone.headers.get("set-cookie") ?? "").toContain("already");
    }
  expect(answerKeeper(app, id + 1000)).toEqual({ done: false, message: "That question is already answered." });
});

test("a question for any action is answered with Done", () => {
  const id = Number(
    app.db
      .query("INSERT INTO keeper_attempt (at, cause, action, repo_id, says, outcome, check_at) VALUES (?1, 'red_checks', 'file', ?2, 'Other', 'asked', 0)")
      .run(Date.now(), repo.id).lastInsertRowid,
  );
  expect(answerKeeper(app, id).message).toBe("Done.");
});

test("the owner's answer is on the audit trail with the owner as actor", () => {
  app.db.query("DELETE FROM event WHERE kind = 'keeper.answered'").run();
  const id = ask();
  expect(answerKeeper(app, id, admin.id).done).toBe(true);
  const row = app.db.query<{ actor_id: string | null }, []>("SELECT actor_id FROM event WHERE kind = 'keeper.answered'").get();
  expect(row?.actor_id).toBe(admin.id);
});

test("unstick: the sweep runs, the row is pending, and it is undone when landings do not rise", async () => {
  app.db.query("DELETE FROM keeper_attempt").run();
  app.db.query("UPDATE issue SET state = 'open' WHERE repo_id = ?1 AND title LIKE 'Work %'").run(repo.id);
  let swept = 0;
  const t = new Date(Date.now() + 400 * EFFECT_MS);
  expect(tickKeeper(app, t, () => void (swept += 1))).toEqual({ cause: "unassigned", acted: "unstick" });
  expect(swept).toBe(1);
  const [row] = listAttempts(app.db);
  expect(row).toMatchObject({ action: "unstick", outcome: "pending", cause: "unassigned" });
  tickKeeper(app, new Date(t.getTime() + EFFECT_MS + 1000), () => void (swept += 1));
  expect(listAttempts(app.db).find((a) => a.action === "unstick")?.outcome).toBe("undone");
});

test("isLow, readRate and keeperDays bucket pulls and runs by hour and UTC day", () => {
  const T = Date.UTC(2040, 0, 10, 12, 30);
  let n = 0;
  const land = (iso: string): void => {
    const issue = openIssue(app, admin, fresh(), { title: `Seed ${(n += 1)}` });
    if (!issue.ok) throw new Error(String(issue.error));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
      .run(issue.value.id, fresh().defaultBranch, `seed/${n}`, repo.id, iso);
  };
  for (let i = 0; i < 3; i++) land("2040-01-10T11:45:00.000Z");
  land("2040-01-09T23:50:00.000Z");
  for (let i = 0; i < 12; i++) land("2040-01-08T10:30:00.000Z");
  app.db
    .query("INSERT INTO run (id, repo_id, kind, state, started_at) VALUES ('keeper-seed-run', ?1, 'agent', 'ok', '2040-01-10T09:10:00.000Z')")
    .run(repo.id);
  const rate = readRate(app.db, new Date(T));
  expect(rate.lastHour).toBe(3);
  expect(rate.recent).toBe(1);
  expect(rate.best).toBe(4);
  expect(rate.ranShare).toBeCloseTo(3 / 24);
  expect(isLow(rate)).toBe(true);
  const rated = (recent: number, best: number): Rate => ({ lastHour: 0, recent, best, ranShare: 0 });
  expect(isLow(rated(0.5, 0))).toBe(true);
  expect(isLow(rated(1, 1.5))).toBe(false);
  expect(isLow(rated(1.2, 5))).toBe(true);
  expect(isLow(rated(2.5, 5))).toBe(false);
  const days = keeperDays(app.db, new Date(T));
  expect(days.map((d) => d.day)).toEqual(["2040-01-04", "2040-01-05", "2040-01-06", "2040-01-07", "2040-01-08", "2040-01-09", "2040-01-10"]);
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  expect(byDay["2040-01-10"]).toEqual({ day: "2040-01-10", hoursRunning: 2, landed: 3 });
  expect(byDay["2040-01-09"]).toEqual({ day: "2040-01-09", hoursRunning: 1, landed: 1 });
  expect(byDay["2040-01-08"]).toEqual({ day: "2040-01-08", hoursRunning: 1, landed: 12 });
  expect(byDay["2040-01-07"]).toEqual({ day: "2040-01-07", hoursRunning: 0, landed: 0 });
});

test("the terminal shows the keeper line and its one button on Flow, and Forge per day on the scorecard", async () => {
  const id = ask();
  const keeper = readKeeper(app.db, true);
  expect(keeper.ask?.id).toBe(id);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: admin },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  const key = async (k: string): Promise<string> => {
    tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
    return tui.screen.toText();
  };
  tui.push(flowScreen(tui.ctx, flowLines(app.db, new Date(), undefined, undefined, undefined, null, undefined, keeper), { ask: keeper.ask!, answer: () => answerKeeper(app, id, admin.id) }));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Leave it?");
  expect(tui.screen.toText()).toContain("Press l");
  await key("l");
  await key("right");
  await key("enter");
  expect(readKeeper(app.db, true).ask).toBeNull();
  tui.push(scorecardScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Forge 20");
  expect(tui.screen.toText()).toContain("running");
});
