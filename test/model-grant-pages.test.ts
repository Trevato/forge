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
import { createOrg } from "../src/core/orgs.ts";
import { getAccountCeiling } from "../src/core/account_ceiling.ts";
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
        origin: "seed",
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
    expect(refused.status).toBe(403);
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
    expect((await post(bobTok.token, 5)).status).toBe(403);
    expect((await post(tok.token, "5")).status).toBe(422);
    expect((await post(tok.token, -1)).status).toBe(422);
    expect((await post(tok.token, 7.5)).status).toBe(200);
    const carol = getUserByName(app.db, "carol")!;
    expect(getModelGrant(app.db, carol.id)?.usdPerMonth).toBe(7.5);
    expect((await post(tok.token, null)).status).toBe(200);
    expect(getModelGrant(app.db, carol.id)).toBeUndefined();
  });

  test("the ceiling route: signed out, a person's 403, a bad amount's flash, saved; the card shows it", async () => {
    const url = `${servers.url}/settings/accounts/carol/ceiling`;
    const send = (cookie: string | undefined, daily: string, perRun: string) =>
      fetch(url, {
        method: "POST",
        headers: cookie === undefined ? {} : { cookie },
        body: new URLSearchParams({ daily, perRun }),
        redirect: "manual",
      });
    const carol = getUserByName(app.db, "carol")!;
    const alice = await signIn("alice");
    const bob = await signIn("bob");
    expect((await send(undefined, "5", "1")).status).not.toBe(200);
    expect(getAccountCeiling(app.db, carol.id)).toBeUndefined();
    expect((await send(bob, "5", "1")).status).toBe(403);
    expect(getAccountCeiling(app.db, carol.id)).toBeUndefined();
    const bad = await send(alice, "abc", "1");
    expect(bad.status).toBe(303);
    expect(getAccountCeiling(app.db, carol.id)).toBeUndefined();
    const carried = (bad.headers.get("set-cookie") ?? "").split(";")[0]!;
    const flash = await (await fetch(`${servers.url}/settings/accounts/carol`, {
      headers: { cookie: `${alice}; ${carried}` },
    })).text();
    expect(flash).toContain("A ceiling is dollars");
    expect((await send(alice, "12.5", "3")).status).toBe(303);
    expect(getAccountCeiling(app.db, carol.id)).toEqual({ dailyUsd: 12.5, perRunUsd: 3 });
    const page = await (await fetch(`${servers.url}/settings/accounts/carol`, {
      headers: { cookie: alice },
    })).text();
    expect(page).toContain("$12.50 a day, $3.00 a run; $12.50 left today.");
    // Both fields empty takes them back; one empty is refused.
    expect((await send(alice, "5", "")).status).toBe(303);
    expect(getAccountCeiling(app.db, carol.id)).toEqual({ dailyUsd: 12.5, perRunUsd: 3 });
    expect((await send(alice, "", "")).status).toBe(303);
    expect(getAccountCeiling(app.db, carol.id)).toBeUndefined();
    const ev = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'account.ceiling_set' ORDER BY id DESC LIMIT 1")
      .get()!;
    expect(JSON.parse(ev.payload)).toEqual({ username: "carol", dailyUsd: null, perRunUsd: null });
  });

  test("an organization has a ceiling page and an API door; a person's token is refused", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const org = createOrg(app.db, "yardco", alice.id);
    if (!org.ok) throw new Error(String(org.error));
    const cookie = await signIn("alice");
    const page = await fetch(`${servers.url}/settings/accounts/yardco`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("No ceiling set.");
    const bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin");
    const tok = createToken(app.db, alice.id, "t", "admin");
    const post = (token: string, body: unknown, name = "yardco") =>
      fetch(`${servers.url}/api/v1/admin/accounts/${name}/ceiling`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(bobTok.token, { dailyUsd: 5, perRunUsd: 1 })).status).toBe(403);
    expect((await post(tok.token, { dailyUsd: "5", perRunUsd: 1 })).status).toBe(422);
    expect((await post(tok.token, { dailyUsd: 0, perRunUsd: 1 })).status).toBe(422);
    expect((await post(tok.token, { dailyUsd: 5, perRunUsd: 1 }, "nobody")).status).toBe(404);
    expect((await post(tok.token, { dailyUsd: 30, perRunUsd: 8 })).status).toBe(200);
    const yardco = getUserByName(app.db, "yardco")!;
    expect(getAccountCeiling(app.db, yardco.id)).toEqual({ dailyUsd: 30, perRunUsd: 8 });
    expect((await post(tok.token, { dailyUsd: null, perRunUsd: 8 })).status).toBe(422);
    expect((await post(tok.token, { dailyUsd: null, perRunUsd: null })).status).toBe(200);
    expect(getAccountCeiling(app.db, yardco.id)).toBeUndefined();
    // The org's own page links to the ceilings; a person who is not an admin sees no link.
    const orgPage = await (await fetch(`${servers.url}/yardco`, { headers: { cookie } })).text();
    expect(orgPage).toContain('href="/settings/accounts/yardco"');
    const bobOrg = await (await fetch(`${servers.url}/yardco`, { headers: { cookie: await signIn("bob") } })).text();
    expect(bobOrg).not.toContain("/settings/accounts/yardco");
  });
});
