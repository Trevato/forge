/** The week's pace wired in (#8695): the tick releases gated work when behind, the pace cuts slots when ahead, and home and the terminal print the sentence. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { readForgeUsage } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue, getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteMeasure } from "../src/core/measure.ts";
import { setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { type User } from "../src/core/users.ts";
import { driveRepo, repoPace } from "../src/crew/autonomy.ts";
import { forgetWeek, weekWords } from "../src/crew/week_read.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { weekLine } from "../src/web/studio/week_line.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const DAY = 86_400_000;
const NOW = new Date();
let dir: string;
let app: App;
let alice: User;
let repo: Repo;
let sub: string;
let gate: Issue;
let gated: Issue;

/** A run that spent `usd` at `at`, on the account. */
function spend(usd: number, at: Date): void {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent" });
  recordUsage(app.db, {
    runId: run.id,
    repoId: repo.id,
    issueId: null,
    agentId: null,
    subscriptionId: sub,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: usd,
    wallMs: 1000,
    outcome: "ok",
    at: at.toISOString(),
  });
}

/** The meter, read an hour ago at `freePct`: the burn is how far it has fallen since. */
function seedReading(scope: string, freePct: number): void {
  app.db.query("DELETE FROM week_reading").run();
  app.db.query("INSERT INTO week_reading (scope, at, free_pct) VALUES (?1, ?2, ?3)").run(scope, new Date(NOW.getTime() - 3_600_000).toISOString(), freePct);
}

/** The provider says the week is `used`% used, half over (reset 3.5 days ahead); the meter read `recent` points higher an hour ago. */
function measure(account: string, used: number, at: Date = NOW): void {
  noteMeasure(app.db, account, { window: "week", usedPct: used, resetsAt: new Date(NOW.getTime() + 3.5 * DAY).toISOString(), observedAt: at.toISOString() });
}

function week(usedSoFar: number, recent = 0): void {
  measure(sub, usedSoFar);
  // The meter read `recent` points higher an hour ago: that is the burn, an hour. Zero is a flat meter.
  seedReading(sub, 100 - usedSoFar + recent);
  forgetWeek();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-week-wiring-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const made = await createRepo(app, alice, { name: "svc", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const bot = await createAgent(app, alice, { username: "builderbot" });
  if (!bot.ok) throw new Error(String(bot.error));
  expect(addToCrew(app, alice, repo, "builderbot").ok).toBe(true);
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Ship it.",
    autonomyCeilingUsd: 1000,
    autonomySlots: 4,
    autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
  repo = getRepoById(app.db, repo.id)!;
  const added = addSubscription(app.db, dir, { name: "main", token: "sk-ant-oat01-week-wiring-1" });
  if (!added.ok) throw new Error(added.error);
  sub = added.value.id;
  setHeadroom(app.db, sub, 0);
  app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(repo.id, sub);
  const g = openIssue(app, alice, repo, { title: "Later gate: nothing behind this starts until the owner opens it" });
  const w = openIssue(app, alice, repo, { title: "Ship the widget" });
  if (!g.ok || !w.ok) throw new Error("issues");
  gate = g.value;
  gated = w.value;
  expect(addDependency(app.db, gated, gate, alice.id).ok).toBe(true);
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => forgetWeek());

test("behind pace, with an idle slot and nothing startable, the tick releases the gated issue and says why", async () => {
  week(20);
  expect(await driveRepo(app, repo, NOW)).toBe("released");
  const blockers = app.db.query("SELECT COUNT(*) AS n FROM issue_dependency WHERE issue_id = ?1").get(gated.id) as { n: number };
  expect(blockers.n).toBe(0);
  const comments = app.db.query("SELECT body FROM comment WHERE issue_id = ?1").all(gated.id) as { body: string }[];
  expect(comments.map((c) => c.body).join("\n")).toContain("Released from Later to use the week's subscription: Behind pace");
  expect(getIssueById(app.db, gated.id)?.state).toBe("open");
});

test("on pace, the gated issue stays behind the gate", async () => {
  const again = openIssue(app, alice, repo, { title: "Polish the widget" });
  if (!again.ok) throw new Error("issue");
  expect(addDependency(app.db, again.value, gate, alice.id).ok).toBe(true);
  // Nothing startable remains for the first issue once it is picked; pace is what decides.
  week(50, 1.4);
  expect(await driveRepo(app, repo, NOW)).not.toBe("released");
  expect(getIssue(app.db, repo.id, again.value.number)).toBeDefined();
  const blockers = app.db.query("SELECT COUNT(*) AS n FROM issue_dependency WHERE issue_id = ?1").get(again.value.id) as { n: number };
  expect(blockers.n).toBe(1);
});

test("ahead of pace, the pace cuts the slots, and the reserve stops them", () => {
  week(70, 6);
  expect(repoPace(app, repo, NOW).slots).toBe(2);
  expect(repoPace(app, repo, NOW).reason).toContain("Ahead of pace");
  week(95);
  expect(repoPace(app, repo, NOW).slots).toBe(0);
  week(50, 0.47);
  expect(repoPace(app, repo, NOW).slots).toBe(4);
});

test("home and the terminal print the same sentence, the terminal for an admin", async () => {
  week(20);
  const words = weekWords(app, NOW)!;
  expect(words).toContain("Behind pace: 80% of the week left");
  expect(words).toContain("Nothing has landed");
  expect(String(weekLine(app, NOW))).toContain("Behind pace: 80% of the week left");
  const terminal = headlessTerminal(240, 32);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
    { terminal, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop();
  expect(text).toContain("Behind pace");
});

test("a fast afternoon slows the crew at once, on a week whose total is on pace", () => {
  week(50);
  const calm = repoPace(app, repo, NOW).slots;
  expect(calm).toBe(4);
  // The meter fell 9 points in the last hour.
  week(77, 9);
  expect(repoPace(app, repo, NOW).slots < calm).toBe(true);
  expect(repoPace(app, repo, NOW).reason).toContain("running out about");
});

test("with no measurement of the week the pace is unknown and the crew holds at a modest level", () => {
  app.db.query("DELETE FROM subscription_measure").run();
  forgetWeek();
  expect(weekWords(app, NOW)).toContain("pace is unknown");
  expect(String(weekLine(app, NOW))).toContain("pace is unknown");
  expect(repoPace(app, repo, NOW).slots).toBe(2);
});

test("a crew on the forge's own token is metered: today's numbers, read from the provider's measure, slow it", () => {
  // The cause of #8873: no grant meant no account, no week, no pacing.
  app.db.query("DELETE FROM subscription_grant").run();
  app.db.query("DELETE FROM usage").run();
  try {
    // The provider measured 54% used; an hour ago the meter read 2.7 points higher.
    measure("platform", 54);
    seedReading("platform", 46 + 2.7);
    forgetWeek();
    const pace = repoPace(app, repo, NOW);
    expect(pace.reason).toContain("46% of the week left");
    expect(pace.reason).toContain("running out about");
    expect(pace.slots < 4).toBe(true);
    expect(weekWords(app, NOW)).toContain("46% of the week left");
  } finally {
    app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(repo.id, sub);
  }
});

test("the free percent home prints is the one the usage tool reports for the same state (#8910)", () => {
  for (const used of [20, 45.4, 54.6, 70]) {
    week(used, 0);
    const home = /(\d+)% of the week left/.exec(weekWords(app, NOW)!)![1];
    const usage = readForgeUsage(app, alice, NOW).subscriptions.find((s) => s.subscription === "main")!.headroom.find((w) => w.window === "week")!.pct;
    expect(Number(home)).toBe(usage!);
  }
});

test("readWeek stores a reading of the meter, so the burn is not seeded by hand only", () => {
  week(30, 0);
  app.db.query("DELETE FROM week_reading").run();
  forgetWeek();
  weekWords(app, NOW);
  const rows = app.db.query("SELECT scope, free_pct FROM week_reading").all() as { scope: string; free_pct: number }[];
  expect(rows).toEqual([{ scope: sub, free_pct: 70 }]);
  // Read an hour on, 4 points lower: the burn is that fall, from the two stored readings.
  measure(sub, 34, new Date(NOW.getTime() + 3_600_000));
  forgetWeek();
  expect(weekWords(app, new Date(NOW.getTime() + 3_600_000))).toContain("burning 4% an hour");
});

test("home reads the repository the crew works, not the first by name", async () => {
  week(20);
  spend(1, new Date(NOW.getTime() - DAY));
  const quiet = await createRepo(app, alice, { name: "aaa-quiet", visibility: "private" });
  if (!quiet.ok) throw new Error(String(quiet.error));
  expect(addToCrew(app, alice, quiet.value, "builderbot").ok).toBe(true);
  const on = await updateRepoSettings(app, alice, quiet.value, { autonomy: "autonomous", autonomyDirection: "Ship.", autonomyCeilingUsd: 1000, autonomySlots: 4, autonomyBy: alice.id });
  expect(on.ok).toBe(true);
  app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(quiet.value.id, sub);
  forgetWeek();
  const words = weekWords(app, NOW)!;
  expect(words).toContain("Nothing has landed this week");
  expect(words).not.toContain("(0 runs");
  expect(words).toMatch(/\(\d+ runs/);
});

test("a week that fell 8 points in 3 hours slows the picks; a flat meter does not (#8960)", () => {
  const threeHoursAgo = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
  const readAt = (freePct: number) => {
    app.db.query("DELETE FROM week_reading").run();
    app.db.query("INSERT INTO week_reading (scope, at, free_pct) VALUES (?1, ?2, ?3)").run(sub, threeHoursAgo, freePct);
    forgetWeek();
  };
  // 3 hours ago the provider read 8 points more free than it does now: 8/3 points an hour, over an hour allowed 0.7.
  measure(sub, 60);
  readAt(48);
  const falling = repoPace(app, repo, NOW);
  expect(falling.slots < 4).toBe(true);
  expect(falling.reason).toContain("2.7% an hour");
  // The same measure, unmoved over the same 3 hours: 0% an hour, no slowing.
  readAt(40);
  const flat = repoPace(app, repo, NOW);
  expect(flat.slots).toBe(4);
  expect(weekWords(app, NOW)).toContain("burning 0% an hour");
});
