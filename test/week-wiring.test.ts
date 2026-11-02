/** The week's pace wired in (#8695): the tick releases gated work when behind, the pace cuts slots when ahead, and home and the terminal print the sentence. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue, getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit, setHeadroom } from "../src/core/standing.ts";
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

/** The week is half over; last week the provider refused at $100, so the cap is known. */
function week(usedSoFar: number): void {
  app.db.query("DELETE FROM usage").run();
  spend(100, new Date(NOW.getTime() - 4 * DAY));
  noteLimit(app.db, sub, {
    window: "week",
    resetsAt: new Date(NOW.getTime() - 3.5 * DAY).toISOString(),
    observedAt: new Date(NOW.getTime() - 3.5 * DAY - 3_600_000).toISOString(),
    said: "weekly limit",
  });
  if (usedSoFar > 0) spend(usedSoFar, new Date(NOW.getTime() - DAY));
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
  week(50);
  expect(await driveRepo(app, repo, NOW)).not.toBe("released");
  expect(getIssue(app.db, repo.id, again.value.number)).toBeDefined();
  const blockers = app.db.query("SELECT COUNT(*) AS n FROM issue_dependency WHERE issue_id = ?1").get(again.value.id) as { n: number };
  expect(blockers.n).toBe(1);
});

test("ahead of pace, the pace cuts the slots, and the reserve stops them", () => {
  week(70);
  expect(repoPace(app, repo, NOW).slots).toBe(2);
  expect(repoPace(app, repo, NOW).reason).toContain("Ahead of pace");
  week(95);
  expect(repoPace(app, repo, NOW).slots).toBe(0);
  week(50);
  expect(repoPace(app, repo, NOW).slots).toBe(4);
});

test("home and the terminal print the same sentence, the terminal for an admin", async () => {
  week(20);
  const words = weekWords(app, NOW)!;
  expect(words).toContain("Behind pace by 30%");
  expect(words).toContain("Nothing has landed");
  expect(String(weekLine(app, NOW))).toContain("Behind pace by 30%");
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
  // 3 points an hour over the last 3 hours, in $100 of cap: $9 an hour.
  spend(27, new Date(NOW.getTime() - 3_600_000));
  forgetWeek();
  expect(repoPace(app, repo, NOW).slots < calm).toBe(true);
  expect(repoPace(app, repo, NOW).reason).toContain("running out about");
});

test("with no known weekly cap the pace is unknown and the crew holds at a modest level", () => {
  app.db.query("DELETE FROM subscription_limit").run();
  app.db.query("DELETE FROM usage").run();
  forgetWeek();
  expect(weekWords(app, NOW)).toContain("pace is unknown");
  expect(String(weekLine(app, NOW))).toContain("pace is unknown");
  expect(repoPace(app, repo, NOW).slots).toBe(2);
});

test("a crew on the forge's own token is metered: today's numbers, read through the ledger, slow it", () => {
  // The cause of #8873: no grant meant no account, no week, no pacing.
  app.db.query("DELETE FROM subscription_grant").run();
  app.db.query("DELETE FROM usage").run();
  try {
    const at = (days: number) => new Date(NOW.getTime() + days * DAY);
    const onPlatform = (usd: number, when: Date) => {
      const run = createRun(app.db, { repoId: repo.id, kind: "agent" });
      recordUsage(app.db, { runId: run.id, repoId: repo.id, issueId: null, agentId: null, subscriptionId: "platform", tokensIn: 1, tokensOut: 1, costUsd: usd, wallMs: 1000, outcome: "ok", at: when.toISOString() });
    };
    // Last week's limit hit at $100; the reset is 5.3 days off; $54 is spent, $8.1 of it in the last 3 hours: 46% free, 2.7 points an hour.
    onPlatform(100, at(-2));
    noteLimit(app.db, "platform", { window: "week", resetsAt: at(-1.7).toISOString(), observedAt: at(-1.7 - 1 / 24).toISOString(), said: "weekly limit" });
    onPlatform(45.9, at(-1));
    onPlatform(8.1, new Date(NOW.getTime() - 3_600_000));
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
