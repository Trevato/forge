/** The week's ceiling wired in (#8695): the crew waits at the budget's share, and home and the terminal print the sentence. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { readForgeUsage } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteMeasure } from "../src/core/measure.ts";
import { setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { type User } from "../src/core/users.ts";
import { repoPace } from "../src/crew/autonomy.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { capacityDefault, setCapacity } from "../src/core/capacity.ts";
import { forgetWeek, weekWords } from "../src/crew/week_read.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { weekLine } from "../src/web/studio/week_line.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { serve } from "../src/http/server.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const DAY = 86_400_000;
const NOW = new Date();
let dir: string;
let app: App;
let alice: User;
let repo: Repo;
let sub: string;

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

/** The provider says the week is `used`% used, half over (reset 3.5 days ahead). */
function measure(account: string, used: number, at: Date = NOW): void {
  noteMeasure(app.db, account, { window: "week", usedPct: used, resetsAt: new Date(NOW.getTime() + 3.5 * DAY).toISOString(), observedAt: at.toISOString() });
}

function week(usedSoFar: number): void {
  measure(sub, usedSoFar);
  forgetWeek();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-week-wiring-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  setCapacity(app.db, "crew.concurrency", "4", alice.id); // pace floor follows Speed: half of 4 is 2
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
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => forgetWeek());
// A failed expectation must not leave the lowered crew concurrency for later tests.
afterEach(() => {
  changeCapacity(app, alice, "crew.concurrency", "4");
});

test("below the budget's share the crew runs at its slots, and at it the crew waits", () => {
  week(50);
  expect(repoPace(app, repo, NOW).slots).toBe(4);
  week(95);
  expect(repoPace(app, repo, NOW).slots).toBe(0);
  expect(repoPace(app, repo, NOW).reason).toContain("95% of the week used, the crew may use up to 90%");
  setCapacity(app.db, "week.use", "100", alice.id); // a budget of 100% runs until the provider refuses
  forgetWeek();
  expect(repoPace(app, repo, NOW).slots).toBe(4);
  setCapacity(app.db, "week.use", "90", alice.id);
});

test("home and the terminal print the same sentence, the terminal for an admin", async () => {
  week(20);
  const words = weekWords(app, NOW)!;
  expect(words).toContain("20% of the week used, the crew may use up to 90%");
  expect(words).toContain("Nothing has landed");
  expect(String(weekLine(app, NOW))).toContain("20% of the week used");
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
  expect(text).toContain("20% of the week used");
});

test("the week sentence says when crew concurrency is below its ceiling, and not at it", () => {
  week(20);
  const ceiling = Number(capacityDefault("crew.concurrency"));
  expect(changeCapacity(app, alice, "crew.concurrency", String(ceiling)).ok).toBe(true);
  expect(weekWords(app, NOW)!).not.toContain("below its ceiling");
  expect(changeCapacity(app, alice, "crew.concurrency", "1").ok).toBe(true);
  forgetWeek();
  expect(weekWords(app, NOW)!).toContain(`Crew concurrency is set to 1, below its ceiling of ${ceiling}`);
});

test("Usage → Spend carries the same sentence, so the week is not mistaken for the cap", async () => {
  week(20);
  const servers = await serve(app);
  try {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-long-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const spend = () => fetch(`${servers.url}/settings/spend`, { headers: { cookie } }).then((r) => r.text());
    expect(changeCapacity(app, alice, "crew.concurrency", String(Number(capacityDefault("crew.concurrency")))).ok).toBe(true);
    forgetWeek();
    expect(await spend()).not.toContain("below its ceiling");
    expect(changeCapacity(app, alice, "crew.concurrency", "1").ok).toBe(true);
    forgetWeek();
    expect((await spend()).replace(/\s+/g, " ")).toContain("below its ceiling of");
  } finally {
    servers.stop();
  }
});

test("with no measurement of the week nothing holds the crew and home says nothing of it", () => {
  app.db.query("DELETE FROM subscription_measure").run();
  forgetWeek();
  expect(weekWords(app, NOW)).toBeNull();
  expect(String(weekLine(app, NOW))).toBe("");
  expect(repoPace(app, repo, NOW).slots).toBe(4);
});

test("a crew on the forge's own token is metered: the provider's measure stops it at the budget", () => {
  // The cause of #8873: no grant meant no account, no week.
  app.db.query("DELETE FROM subscription_grant").run();
  app.db.query("DELETE FROM usage").run();
  setCapacity(app.db, "week.use", "50", alice.id);
  try {
    measure("platform", 54);
    forgetWeek();
    expect(repoPace(app, repo, NOW).slots).toBe(0);
    expect(weekWords(app, NOW)).toContain("54% of the week used");
  } finally {
    setCapacity(app.db, "week.use", "90", alice.id);
    app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(repo.id, sub);
  }
});

test("the used percent home prints is the one the usage tool reports for the same state (#8910) is the one the usage tool reports for the same state (#8910)", () => {
  for (const used of [20, 45.4, 54.6, 70]) {
    week(used);
    const home = /(\d+)% of the week used/.exec(weekWords(app, NOW)!)![1];
    const usage = readForgeUsage(app, alice, NOW).subscriptions.find((s) => s.subscription === "main")!.headroom.find((w) => w.window === "week")!.pct;
    expect(100 - Number(home)).toBe(usage!);
  }
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
