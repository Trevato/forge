/**
 * The `subscription_budget` tool is POST /settings/subscriptions/:id/budget
 * over MCP: the same `setBudget`, so the same refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSubscription, budgetsOf, lockBudget } from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP subscription_budget", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let bob = "";
  let open = "";
  let locked = "";
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "subscription_budget", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    // A tool the caller may not see is a JSON-RPC error, not a result.
    if (!body.result) return { text: JSON.stringify(body.error), error: true };
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-budget-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = (username: string) =>
      createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
    const a = await mk("alice");
    const b = await mk("bob");
    if (!a.ok || !b.ok) throw new Error("users");
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    const s = addSubscription(app.db, dataDir, { name: "open", token: "sk-ant-api03-open-key-for-the-mcp-budget" });
    const l = addSubscription(app.db, dataDir, { name: "locked", token: "sk-ant-api03-locked-key-for-the-mcp-budget" });
    if (!s.ok || !l.ok) throw new Error("subs");
    open = s.value.id;
    locked = l.value.id;
    lockBudget(app.db, locked, 8);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets a budget and the page shows it; clearing works when unlocked", async () => {
    const set = await call(admin, { id: open, usd: 12.5 });
    expect(set.error).toBe(false);
    expect(JSON.parse(set.text)).toMatchObject({ id: open, budgetUsd: 12.5 });
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie } });
    expect(await page.text()).toContain('value="12.5"');
    const cleared = await call(admin, { id: open, usd: null });
    expect(cleared.error).toBe(false);
    expect(JSON.parse(cleared.text).budgetUsd).toBeNull();
    expect(budgetsOf(app.db).get(open)?.budgetUsd).toBeNull();
  });

  test("a value above the limit, a bad value, or an unknown id is refused", async () => {
    const over = await call(admin, { id: open, usd: 1e9 });
    expect(over.error).toBe(true);
    expect(over.text).toContain("invalid");
    expect((await call(admin, { id: open, usd: "5" })).error).toBe(true);
    expect((await call(admin, { id: "nope", usd: 5 })).text).toContain("not_found");
    expect(budgetsOf(app.db).get(open)?.budgetUsd).toBeNull();
  });

  test("a locked budget is lowered, never raised or cleared", async () => {
    expect((await call(admin, { id: locked, usd: 20 })).text).toContain("locked");
    expect((await call(admin, { id: locked, usd: null })).text).toContain("locked");
    expect((await call(admin, { id: locked, usd: 5 })).error).toBe(false);
    expect(budgetsOf(app.db).get(locked)?.budgetUsd).toBe(5);
  });

  test("a non-admin is refused", async () => {
    expect((await call(bob, { id: open, usd: 5 })).error).toBe(true);
    expect(budgetsOf(app.db).get(open)?.budgetUsd).toBeNull();
  });
});
