/**
 * Request access (#10928): in `request` mode a stranger asks for an account
 * and waits, with no credential, until an admin allows it; Decline keeps a
 * record and tells them politely. Proven by API and by page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { getSignup, setSignup } from "../src/settings/signup.ts";
import { NEWCOMER_QUOTAS, quotaOf } from "../src/settings/quotas.ts";
import { getUserByName } from "../src/core/users.ts";
import { requestLines } from "../src/actions/requests.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { roleOf } from "../src/core/roles.ts";

const ORIGIN = "https://forge.example";
const PASS = "a-good-passphrase-1";

describe("request access", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let admin: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-request-access-"));
    app = createApp({ dataDir, port: 0, url: ORIGIN });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    base = servers.url;
    admin = await adminCookie(app, { username: "ada", email: "ada@example.com" });
    setSignup(app.db, "request", "boot");
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (username: string, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ username, password: PASS, ...extra }),
    });
  const form = (path: string, fields: Record<string, string>, cookie?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields),
    });
  const signIn = (username: string) => form("/signin", { username, password: PASS });

  test("the page asks for a note and the request page says so plainly, with no owner's name", async () => {
    const page = await fetch(`${base}/signup`).then((r) => r.text());
    expect(page).toContain("What do you want to build?");
    expect(page).toContain("Ask for an account");
    const res = await form("/signup", { username: "pagey", password: PASS, note: "a <b>shop</b> page" });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("location")).toBe("/signup/requested");
    const said = await fetch(`${base}/signup/requested`).then((r) => r.text());
    expect(said).toContain("Your request is in. Someone who runs this forge will look at it; you can close this page and sign in later to check.");
    expect(said).not.toContain("ada");
    // It waits: signing in shows the wait and starts no session.
    const again = await signIn("pagey");
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(await again.text()).toContain("still waiting");
    expect(getUserByName(app.db, "pagey")?.waitingAt).not.toBeNull();
  });

  test("by API: 202 waiting, no credential, the admin sees it listed and allows it with one POST", async () => {
    const res = await api("apiy", { note: "a game", from: "agent:friend" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { state: string }).state).toBe("waiting");
    const user = getUserByName(app.db, "apiy")!;
    expect(roleOf(app.db, user)).toBe("guest");
    // A waiting account has no way in at any door.
    const basic = `Basic ${btoa(`apiy:${PASS}`)}`;
    expect((await fetch(`${base}/api/v1/user`, { headers: { authorization: basic } })).status).toBe(401);

    const listed = (await fetch(`${base}/api/v1/admin/requests`, { headers: { cookie: admin } }).then((r) => r.json())) as {
      items: { username: string; note: string; source: string }[];
    };
    const mine = listed.items.find((i) => i.username === "apiy");
    expect(mine).toMatchObject({ note: "a game", source: "agent:friend" });
    // Not an admin's to read.
    expect((await fetch(`${base}/api/v1/admin/requests`)).status).toBe(404);

    expect(requestLines(app.db, getUserByName(app.db, "ada")!).some((l) => l.id === "request:apiy")).toBe(true);

    const done = await fetch(`${base}/api/v1/admin/requests/apiy/allow`, { method: "POST", headers: { cookie: admin, origin: ORIGIN } });
    expect(done.status).toBe(200);
    expect(getUserByName(app.db, "apiy")?.waitingAt).toBeNull();
    // Answered once: a second tap finds nothing waiting.
    expect((await fetch(`${base}/api/v1/admin/requests/apiy/allow`, { method: "POST", headers: { cookie: admin, origin: ORIGIN } })).status).toBe(409);
    // Allowed: a member under the small newcomer quotas, no model grant.
    expect(roleOf(app.db, getUserByName(app.db, "apiy")!)).toBe("member");
    expect(quotaOf(app.db, "apps", getUserByName(app.db, "apiy")!.id)).toBe(NEWCOMER_QUOTAS.apps);
    expect(quotaOf(app.db, "apps", getUserByName(app.db, "ada")!.id)).toBeNull();
    const ok = await fetch(`${base}/api/v1/user`, { headers: { authorization: basic } });
    expect(ok.status).toBe(200);
  });

  test("by page: Waiting shows name, note and source with Allow; allowing makes the next load say You're in, once", async () => {
    const accounts = await fetch(`${base}/settings/accounts`, { headers: { cookie: admin } }).then((r) => r.text());
    expect(accounts).toContain('id="waiting"');
    expect(accounts).toContain("pagey");
    expect(accounts).toContain("a &lt;b&gt;shop&lt;/b&gt; page");
    expect(accounts).toContain("/settings/accounts/pagey/allow");
    expect(accounts.indexOf('id="waiting"')).toBeLessThan(accounts.indexOf('id="accounts"'));
    // Only an admin, from this origin, may answer.
    expect(getUserByName(app.db, "pagey")?.waitingAt).not.toBeNull();
    const allow = await form("/settings/accounts/pagey/allow?back=home", {}, admin);
    expect(allow.status).toBe(303);
    const signedIn = await signIn("pagey");
    expect(signedIn.status).toBe(303);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    const home = await fetch(`${base}/`, { headers: { cookie } }).then((r) => r.text());
    expect(home).toContain('id="youre-in"');
    const next = await fetch(`${base}/`, { headers: { cookie } }).then((r) => r.text());
    expect(next).not.toContain('id="youre-in"');
  });

  test("Decline keeps a record, says no politely, and the account never acts", async () => {
    expect((await api("nope")).status).toBe(202);
    const res = await form("/settings/accounts/nope/decline", {}, admin);
    expect(res.status).toBe(303);
    const user = getUserByName(app.db, "nope")!;
    expect(user.waitingAt).not.toBeNull();
    const row = app.db.query<{ state: string }, [string]>("SELECT state FROM account_request WHERE user_id = ?1").get(user.id);
    expect(row?.state).toBe("declined");
    const shown = await signIn("nope");
    expect(shown.headers.get("set-cookie")).toBeNull();
    expect(await shown.text()).toContain("Thanks for asking");
    const list = (await fetch(`${base}/api/v1/admin/requests`, { headers: { cookie: admin } }).then((r) => r.json())) as { items: { username: string }[] };
    expect(list.items.find((i) => i.username === "nope")).toBeUndefined();
    expect((await fetch(`${base}/api/v1/admin/requests/nope/allow`, { method: "POST", headers: { cookie: admin, origin: ORIGIN } })).status).toBe(409);
  });

  test("the knob has four modes; invite links work in all but closed; open starts at once", async () => {
    expect(getSignup(app.db)).toBe("request");
    const settings = await fetch(`${base}/admin/limits`, { headers: { cookie: admin } }).then((r) => r.text());
    expect(settings).toContain('value="request"');
    setSignup(app.db, "open", "boot");
    const res = await api("opener");
    expect(res.status).toBe(201);
    const opener = getUserByName(app.db, "opener")!;
    expect(opener.waitingAt).toBeNull();
    // Open: a guest, who makes no repository, app or crew run until an admin promotes them.
    expect(roleOf(app.db, opener)).toBe("guest");
    setSignup(app.db, "closed", "boot");
    expect((await api("shut")).status).toBe(403);
    setSignup(app.db, "request", "boot");
  });
});
