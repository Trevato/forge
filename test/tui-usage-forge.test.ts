/**
 * The terminal's Usage screen with no repository says the forge's spend
 * (#8308), as MCP `usage` without a repo answers it: today, the last 24 h
 * and each subscription's headroom in percent. A repository's Usage is
 * unchanged: it has no such lines.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readForgeUsage } from "../src/actions/usage.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription, EVERYONE, setGrants } from "../src/core/subscriptions.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { forgeSpendLines } from "../src/tui/screens/usage.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const { app } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(160, 32), exitHooks: false },
  );
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    open: async (command: string, spec?: string) => {
      key("k", true);
      for (const ch of command) key(ch);
      await settleApp(app);
      key("enter");
      await settleApp(app);
      if (spec !== undefined) {
        for (const ch of spec) key(ch);
        await settleApp(app);
        key("enter");
        await settleApp(app);
      }
    },
    stop: () => app.stop(),
  };
}

function runCost(repo: Repo, cost: number, sub: string): void {
  recordUsage(forge.db, {
    runId: createRun(forge.db, { repoId: repo.id, kind: "agent" }).id, repoId: repo.id, issueId: null, agentId: null,
    subscriptionId: sub, tokensIn: 100, tokensOut: 10, costUsd: cost, wallMs: 1000, outcome: "ok", at: new Date().toISOString(),
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-usage-forge-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const alice = getUserByName(forge.db, "alice")!;
  const sub = addSubscription(forge.db, dataDir, { name: "work", token: "sk-ant-api03-work-key-for-the-forge-test" });
  if (!sub.ok) throw new Error("subscription");
  noteLimit(forge.db, sub.value.id, {
    window: "5h", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), observedAt: new Date().toISOString(), said: "limit",
  });
  for (const [name, cost] of [["mill", 1.25], ["kiln", 2]] as const) {
    const made = await createRepo(forge, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(forge, alice, made.value, { message: "seed", files: [{ path: "README.md", content: "# x\n" }] });
    setGrants(forge.db, made.value.id, EVERYONE, [sub.value.id]);
    runCost(made.value, cost, sub.value.id);
  }
}, 30_000);
afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("Usage with no repository draws today, the last 24 h and each subscription's headroom", async () => {
  const alice = getUserByName(forge.db, "alice")!;
  const report = readForgeUsage(forge, alice);
  expect(report.apps).toBe(2);
  expect(report.subscriptions.length).toBeGreaterThan(0);
  const h = boot("alice");
  await h.open("Usage");
  const text = h.text();
  expect(text).toContain("Today: $3.25 over 2 runs");
  expect(text).toContain("Last 24 h: $3.25 over 2 runs");
  expect(text).toContain("Headroom: ");
  for (const s of report.subscriptions) expect(text).toContain(s.subscription);
  expect(text).toContain("work 5h 0%");
  h.stop();
});

test("a repository's Usage has none of those lines", async () => {
  const h = boot("alice");
  await h.open("Usage of a repository", "alice/mill");
  const text = h.text();
  expect(text).not.toContain("Headroom:");
  expect(text).not.toContain("Last 24 h:");
  h.stop();
});

test("a signed-in member reaches the lines, and not the admin's spend", async () => {
  const h = boot("bob");
  await h.open("Usage");
  const text = h.text();
  expect(text).toContain("Today: $0.00 over 0 runs");
  expect(text).not.toContain("$3.25");
  expect(text).toContain("Headroom: ");
  expect(text).not.toContain("routes had no request");
  h.stop();
});

test("a guest is offered no Usage and the screen draws no spend lines", () => {
  const { app } = createForgeApp(
    forge,
    { sshUsername: "git", remoteAddress: "127.0.0.1" },
    { terminal: headlessTerminal(160, 32), exitHooks: false },
  );
  app.start();
  app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
  for (const ch of "Usage") app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
  const text = app.screen.toText();
  expect(text).not.toContain("Today:");
  expect(text).not.toContain("the forge's spend and headroom");
  app.stop();
});

test("each subscription's headroom has its own line", () => {
  const w = { window: "5h", pct: 40 };
  const sub = (subscription: string) => ({ subscription, headroom: [w] });
  const lines = forgeSpendLines({
    today: { costUsd: 0, runs: 0 }, last24h: { costUsd: 0, runs: 0 }, subscriptions: [sub("a"), sub("b"), sub("c")],
  } as never);
  expect(lines.slice(2)).toEqual(["Headroom: a 5h 40%", "          b 5h 40%", "          c 5h 40%"]);
});
