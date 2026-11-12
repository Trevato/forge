/**
 * The terminal's fleet graph (#8048): `f` on Usage opens it (on a repository's
 * Usage, that repository alone); with usage seeded in two
 * repositories the screen names both and their totals are `readFleetGraph`'s; `w` moves
 * between 24 h and 14 d; an empty ledger, or a viewer who may not see the spend, reads
 * "Nothing spent in this window."
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFleetGraph } from "../src/actions/fleet-graph.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { usd } from "../src/core/money.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
const ids: Record<string, string> = {};

function boot(username: string, cols = 120, rows = 32, on: Forge = forge) {
  const user = getUserByName(on.db, username)!;
  const { app } = createForgeApp(
    on,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(cols, rows), exitHooks: false },
  );
  app.start();
  const key = async (k: string, ctrl = false) => {
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(app);
  };
  return {
    text: () => app.screen.toText(),
    key,
    open: async () => {
      await key("k", true);
      for (const ch of "Usage") await key(ch);
      await key("enter");
      await key("f");
    },
    /** The palette's "Usage of a repository" for `spec`. */
    openRepoUsage: async (spec: string) => {
      await key("k", true);
      for (const ch of "Usage of a repository") await key(ch);
      await key("enter");
      for (const ch of spec) await key(ch);
      await key("enter");
    },
    stop: () => app.stop(),
  };
}

function spend(repo: string, usdSpent: number, msAgo: number): void {
  recordUsage(forge.db, {
    runId: createRun(forge.db, { repoId: ids[repo]!, kind: "agent" }).id,
    repoId: ids[repo]!, issueId: null, agentId: null, subscriptionId: null,
    tokensIn: 1, tokensOut: 1, costUsd: usdSpent, wallMs: 1, outcome: "ok",
    at: new Date(Date.now() - msAgo).toISOString(),
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-fleetgraph-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const alice = getUserByName(forge.db, "alice")!;
  for (const name of ["mill", "kiln"]) {
    const made = await createRepo(forge, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    ids[name] = made.value.id;
  }
  spend("mill", 2.5, 60_000);
  spend("mill", 1, 60_000);
  spend("kiln", 4, 60_000);
  spend("kiln", 0.25, 3 * 86_400_000); // only in the 14-day window
}, 30_000);
afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("f opens the graph: both repositories, totals as readFleetGraph answers, w moves to 14 d", async () => {
  const graph = readFleetGraph(forge, getUserByName(forge.db, "alice")!, null);
  const h = boot("alice");
  await h.open();
  const day = h.text();
  expect(day).toContain("alice/mill");
  expect(day).toContain("alice/kiln");
  graph.series.forEach((s, i) => {
    expect(day).toContain(usd(graph.windows[0].totals.costUsd[i]!));
    expect(day).toContain(`${graph.windows[0].totals.runs[i]} ${graph.windows[0].totals.runs[i] === 1 ? "run" : "runs"}`);
    expect(s.label).toBeTruthy();
  });
  expect(day).toContain("$4.00");
  expect(day).toContain("$3.50");
  expect(day).toContain("over 24 h");
  await h.key("w");
  const fortnight = h.text();
  expect(fortnight).toContain("over 14 d");
  expect(fortnight).toContain("$4.25");
  expect(fortnight).toContain("2 runs");
  await h.key("w");
  expect(h.text()).toContain("over 24 h");
  h.stop();
});

test("someone who may not see the spend gets nothing: the action's rule", () => {
  const graph = readFleetGraph(forge, getUserByName(forge.db, "bob")!, null);
  expect(graph.repos).toEqual([]);
  expect(graph.windows[0].totals.costUsd).toEqual([]);
});

test("f on a repository's Usage opens the graph on that repository alone (#578)", async () => {
  const h = boot("alice");
  await h.openRepoUsage("alice/mill");
  expect(h.text()).toContain("Usage · alice/mill");
  expect(h.text()).toContain("fleet graph");
  await h.key("f");
  const one = h.text();
  expect(one).toContain("Fleet graph · alice/mill");
  expect(one).toContain("$3.50");
  expect(one).not.toContain("alice/kiln");
  h.stop();
});

/** A fresh forge with an admin `alice` and `n` repositories, each having spent a little. */
async function fresh(n: number, stem = "app"): Promise<{ on: Forge; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "forge-tui-fleetgraph-x-"));
  const on = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(on.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const alice = getUserByName(on.db, "alice")!;
  for (let i = 0; i < n; i++) {
    const repo = await createRepo(on, alice, { name: `${stem}${i}`, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    recordUsage(on.db, {
      runId: createRun(on.db, { repoId: repo.value.id, kind: "agent" }).id,
      repoId: repo.value.id, issueId: null, agentId: null, subscriptionId: null,
      tokensIn: 1, tokensOut: 1, costUsd: 1 + i, wallMs: 1, outcome: "ok",
      at: new Date(Date.now() - 60_000).toISOString(),
    });
  }
  return { on, done: async () => { on.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("an empty ledger reads Nothing spent in this window.", async () => {
  const { on, done } = await fresh(0);
  const h = boot("alice", 120, 32, on);
  await h.open();
  expect(h.text()).toContain("Nothing spent in this window.");
  h.stop();
  await done();
});

test("past eight series the smallest share \"N others\"", async () => {
  const { on, done } = await fresh(10);
  const h = boot("alice", 120, 40, on);
  await h.open();
  expect(h.text()).toContain("3 others");
  expect(h.text()).toContain("alice/app9");
  expect(h.text()).not.toContain("alice/app0");
  h.stop();
  await done();
});

test("a short terminal says how many rows it cut", async () => {
  const { on, done } = await fresh(10);
  const h = boot("alice", 120, 14, on);
  await h.open();
  expect(h.text()).toMatch(/\+\d+ more rows/);
  h.stop();
  await done();
});

test("at 44 columns every line fits and the long name is cut", async () => {
  const { on, done } = await fresh(2, "a-rather-long-repository-name-");
  const h = boot("alice", 44, 32, on);
  await h.open();
  const lines = h.text().split("\n");
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(44);
  const rows = lines.filter((l) => l.includes("▁") || l.includes("█"));
  expect(rows.length).toBeGreaterThan(0);
  expect(h.text()).toContain("…");
  expect(h.text()).not.toContain("a-rather-long-repository-name-1");
  h.stop();
  await done();
});
