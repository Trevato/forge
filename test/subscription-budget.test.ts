/**
 * A whole-life budget on a sealed account (#601): the crew spends from it
 * until its runs add up to the budget, then the account is not offered and
 * a run says why; raising the budget brings it back. Only an admin sets it,
 * on Subscriptions; the usage read shows it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { readUsage } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import {
  addSubscription,
  budgetsOf,
  EVERYONE,
  lockBudget,
  pickSubscription,
  restSubscription,
  setBudget,
  setGrants,
} from "../src/core/subscriptions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "sk-ant-api03-starter-key-for-the-budget-test";
const KEY2 = "sk-ant-api03-second-key-for-the-budget-test";

describe("an account's whole-life budget", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let starter = "";
  let second = "";
  const scope = () => ({
    repoId: repo.id,
    ownerId: repo.ownerId,
    agentId: "nobody",
  });
  const spend = (subscriptionId: string, usd: number) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent" });
    app.db
      .query("UPDATE run SET subscription_id = ?1, cost_usd = ?2 WHERE id = ?3")
      .run(subscriptionId, usd, run.id);
  };
  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        password: "a-long-budget-passphrase",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-budget-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "a@x.test",
      password: "a-long-budget-passphrase",
      isAdmin: true,
    });
    if (!a.ok) throw new Error("user");
    alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "b@x.test",
      password: "a-long-budget-passphrase",
    });
    if (!b.ok) throw new Error("bob");
    const r = await createRepo(app, alice, { name: "bakery" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
    const s = addSubscription(app.db, dataDir, { name: "starter", token: KEY });
    if (!s.ok) throw new Error("sub");
    starter = s.value.id;
    setGrants(app.db, repo.id, EVERYONE, [starter]);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a budget is dollars above zero, up to a ceiling; the platform has none", () => {
    expect(setBudget(app.db, starter, 0)).toBe(false);
    expect(setBudget(app.db, starter, -5)).toBe(false);
    expect(setBudget(app.db, starter, Number.NaN)).toBe(false);
    expect(setBudget(app.db, starter, 1_000_000)).toBe(false);
    expect(setBudget(app.db, "platform", 20)).toBe(false);
    expect(setBudget(app.db, starter, 1)).toBe(true);
    expect(budgetsOf(app.db).get(starter)).toEqual({
      budgetUsd: 1,
      spentUsd: 0,
      locked: false,
    });
  });

  test("the account is offered until its runs add up to the budget", () => {
    spend(starter, 0.6);
    expect(pickSubscription(app.db, dataDir, scope(), new Date()).kind).toBe(
      "ready",
    );
    spend(starter, 0.5);
    const now = new Date();
    const picked = pickSubscription(app.db, dataDir, scope(), now);
    expect(picked.kind).toBe("resting");
    if (picked.kind !== "resting") return;
    expect(picked.said).toContain("$1 budget is spent");
    // Looked at again within the hour, so a raise is felt soon.
    expect(Date.parse(picked.until) - now.getTime()).toBeLessThanOrEqual(
      3_600_000,
    );
  });

  test("raising the budget brings the account back; clearing it removes the limit", () => {
    expect(setBudget(app.db, starter, 5)).toBe(true);
    expect(pickSubscription(app.db, dataDir, scope(), new Date()).kind).toBe(
      "ready",
    );
    expect(setBudget(app.db, starter, 1)).toBe(true);
    expect(setBudget(app.db, starter, null)).toBe(true);
    expect(pickSubscription(app.db, dataDir, scope(), new Date()).kind).toBe(
      "ready",
    );
    expect(setBudget(app.db, starter, 1)).toBe(true);
  });

  test("a spent account hands over to another on the same grant; a resting one keeps its own wake time", () => {
    const s = addSubscription(app.db, dataDir, { name: "second", token: KEY2 });
    if (!s.ok) throw new Error("sub");
    second = s.value.id;
    setGrants(app.db, repo.id, EVERYONE, [starter, second]);
    const picked = pickSubscription(app.db, dataDir, scope(), new Date());
    expect(picked.kind === "ready" && picked.subscription.id).toBe(second);
    const wake = new Date(Date.now() + 5 * 3_600_000).toISOString();
    restSubscription(app.db, second, wake, "the provider's window is full");
    const rest = pickSubscription(app.db, dataDir, scope(), new Date());
    expect(rest.kind === "resting" && rest.until).toBe(wake);
  });

  test("only an admin sets a budget, and the page shows what is spent of it", async () => {
    const bob = await signIn("bob");
    const refused = await fetch(
      `${servers.url}/settings/subscriptions/${starter}/budget`,
      {
        method: "POST",
        headers: { cookie: bob, origin: servers.url },
        body: new URLSearchParams({ budget: "1000" }),
        redirect: "manual",
      },
    );
    expect(refused.status).toBe(404);
    expect(budgetsOf(app.db).get(starter)!.budgetUsd).toBe(1);
    const admin = await signIn("alice");
    const set = await fetch(
      `${servers.url}/settings/subscriptions/${starter}/budget`,
      {
        method: "POST",
        headers: { cookie: admin, origin: servers.url },
        body: new URLSearchParams({ budget: "20" }),
        redirect: "manual",
      },
    );
    expect(set.status).toBe(303);
    expect(budgetsOf(app.db).get(starter)!.budgetUsd).toBe(20);
    const page = (
      await (
        await fetch(`${servers.url}/settings/subscriptions`, {
          headers: { cookie: admin },
        })
      ).text()
    ).replace(/\s+/g, " ");
    expect(page).toContain("spent $1.10 of a $20 budget");
  });

  test("the usage read (and so the MCP `usage` tool) carries the budget", () => {
    const usage = readUsage(app, alice, repo, 7);
    if (!usage.ok) throw new Error("usage");
    const row = usage.value.standing.find((s) => s.subscription === "starter")!;
    expect(row.budget).toEqual({ usd: 20, spentUsd: 1.1, locked: false });
  });

  test("a locked budget — a spawned child's starter key — is not raised from inside the forge", async () => {
    expect(lockBudget(app.db, starter, 3)).toBe(true);
    // Never raised, never cleared — lowering is allowed.
    expect(setBudget(app.db, starter, 1000)).toBe(false);
    expect(setBudget(app.db, starter, 3)).toBe(false);
    expect(setBudget(app.db, starter, null)).toBe(false);
    expect(setBudget(app.db, starter, 2)).toBe(true);
    expect(budgetsOf(app.db).get(starter)).toMatchObject({ budgetUsd: 2, locked: true });
    // Even the forge's admin, through the page, is refused and told why.
    const admin = await signIn("alice");
    const res = await fetch(`${servers.url}/settings/subscriptions/${starter}/budget`, {
      method: "POST",
      headers: { cookie: admin, origin: servers.url },
      body: new URLSearchParams({ budget: "1000" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(budgetsOf(app.db).get(starter)!.budgetUsd).toBe(2);
    const page = (await (await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie: admin } })).text()).replace(/\s+/g, " ");
    expect(page).toContain("set by whoever made this forge");
    // Lowering it from the page is allowed.
    const lower = await fetch(`${servers.url}/settings/subscriptions/${starter}/budget`, {
      method: "POST",
      headers: { cookie: admin, origin: servers.url },
      body: new URLSearchParams({ budget: "1.5" }),
      redirect: "manual",
    });
    expect(lower.status).toBe(303);
    expect(budgetsOf(app.db).get(starter)!.budgetUsd).toBe(1.5);
  });

  test("runs started together reserve what they may spend: two cannot both pass a budget one fits in", () => {
    const made = addSubscription(app.db, dataDir, { name: "together", token: "sk-ant-api03-together-key-for-the-test" });
    if (!made.ok) throw new Error("sub");
    const id = made.value.id;
    const r = repo;
    setGrants(app.db, r.id, EVERYONE, [id]);
    lockBudget(app.db, id, 8);
    const a = createRun(app.db, { repoId: r.id, kind: "agent" });
    const b = createRun(app.db, { repoId: r.id, kind: "agent" });
    const c = createRun(app.db, { repoId: r.id, kind: "agent" });
    // Each run asks for $5; the budget is $8 and nothing has been spent.
    const first = pickSubscription(app.db, dataDir, scope(), new Date(), { runId: a.id, usd: 5 });
    const second = pickSubscription(app.db, dataDir, scope(), new Date(), { runId: b.id, usd: 5 });
    const third = pickSubscription(app.db, dataDir, scope(), new Date(), { runId: c.id, usd: 5 });
    expect(first.kind === "ready" && first.capUsd).toBe(5);
    // The second gets only what is left, and the third nothing.
    expect(second.kind === "ready" && second.capUsd).toBe(3);
    expect(third.kind).toBe("resting");
    // When the first ends having spent $1, its unspent reservation is free again.
    app.db.query("UPDATE run SET state = 'ok', cost_usd = 1 WHERE id = ?1").run(a.id);
    const again = pickSubscription(app.db, dataDir, scope(), new Date(), { runId: c.id, usd: 5 });
    expect(again.kind === "ready" && again.capUsd).toBe(4);
  });
});
