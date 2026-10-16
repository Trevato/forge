/**
 * The pages and the API for a model grant (#1145): a new account's page says
 * zero in one line, an admin sets the grant from the account's page or the
 * API, and no one else may.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getModelGrant } from "../src/core/model_grant.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-grant-passphrase";

describe("a model grant, from the account's page and the API", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASS }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-grant-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@x.test`,
        password: PASS,
        isAdmin,
      });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a new account's page says its budget is zero in one line", async () => {
    const bob = await signIn("bob");
    const html = await (await fetch(`${servers.url}/settings/model`, { headers: { cookie: bob } })).text();
    expect(html).toContain("Model budget: $0. Add your own subscription, or ask an admin for a grant.");
  });

  test("an admin sets the grant from the account's page; the page shows it; a person cannot", async () => {
    const bob = await signIn("bob");
    const refused = await fetch(`${servers.url}/settings/accounts/bob/model`, {
      method: "POST",
      headers: { cookie: bob },
      body: new URLSearchParams({ usd: "20" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(404);
    expect(getModelGrant(app.db, getUserByName(app.db, "bob")!.id)).toBeUndefined();

    const admin = await signIn("alice");
    const set = await fetch(`${servers.url}/settings/accounts/bob/model`, {
      method: "POST",
      headers: { cookie: admin },
      body: new URLSearchParams({ usd: "20" }),
      redirect: "manual",
    });
    expect(set.status).toBe(303);
    expect(getModelGrant(app.db, getUserByName(app.db, "bob")!.id)?.usdPerMonth).toBe(20);
    const theirs = await (await fetch(`${servers.url}/settings/model`, { headers: { cookie: bob } })).text();
    expect(theirs).toContain("a grant of $20.00 a month, $20.00 left");
    const page = await (await fetch(`${servers.url}/settings/accounts/bob`, { headers: { cookie: admin } })).text();
    expect(page).toContain("a grant of $20.00 a month");
    // Nonsense is refused and changes nothing.
    await fetch(`${servers.url}/settings/accounts/bob/model`, {
      method: "POST",
      headers: { cookie: admin },
      body: new URLSearchParams({ usd: "lots" }),
      redirect: "manual",
    });
    expect(getModelGrant(app.db, getUserByName(app.db, "bob")!.id)?.usdPerMonth).toBe(20);
  });

  test("the API sets and takes back a grant for an admin token only", async () => {
    const admin = getUserByName(app.db, "alice")!;
    const bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin");
    const tok = createToken(app.db, admin.id, "t", "admin");
    const post = (token: string, usd: unknown) =>
      fetch(`${servers.url}/api/v1/admin/accounts/carol/model-grant`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ usdPerMonth: usd }),
      });
    expect((await post(bobTok.token, 5)).status).toBe(404);
    expect((await post(tok.token, "5")).status).toBe(422);
    expect((await post(tok.token, -1)).status).toBe(422);
    expect((await post(tok.token, 7.5)).status).toBe(200);
    const carol = getUserByName(app.db, "carol")!;
    expect(getModelGrant(app.db, carol.id)?.usdPerMonth).toBe(7.5);
    expect((await post(tok.token, null)).status).toBe(200);
    expect(getModelGrant(app.db, carol.id)).toBeUndefined();
  });
});
