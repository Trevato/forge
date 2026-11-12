/**
 * The everyday account (#596): a forge's admin is asked once, kindly, to
 * make an account apart from admin for daily work; making it signs them in
 * as it, keeping admin is recorded; both account pages name the pair. The
 * everyday account is made with a passkey and never a password (#1890). A
 * token for an admin is minted only on purpose, and an MCP client holding
 * one is told it acts as admin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  adminOf,
  everydayOf,
  joinAsWriter,
  keptAdmin,
  WRITERS_TEAM,
} from "../src/core/everyday.ts";
import {
  createOrg,
  createTeam,
  getTeam,
  listTeams,
  orgAccessByOrg,
} from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { listPasskeys } from "../src/core/passkeys.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";
import { ADMIN_TOKEN_WORDS } from "../src/core/tokens.ts";

quietLogs();

const PASSWORD = "a-long-everyday-passphrase";
const WHY = "Admin can change everything here, including who can see what.";

describe("the everyday account", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const url = (path: string) => `${servers.url}${path}`;
  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(url("/signin"), {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const page = async (cookie: string, path: string) =>
    (await (await fetch(url(path), { headers: { cookie } })).text()).replace(
      /\s+/g,
      " ",
    );
  const post = (
    cookie: string,
    path: string,
    form: Record<string, string>,
    origin = servers.url,
  ) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  /** What the page does: a passkey from the options route, then the form. */
  const make = async (cookie: string, form: Record<string, string>) =>
    post(cookie, "/settings/everyday", {
      ...form,
      ...(await passkeyFields(servers.url, "/settings/everyday/options", form, { headers: { cookie } })),
    });
  const hasPassword = (username: string) =>
    (app.db.query("SELECT password_hash AS h FROM user WHERE username = ?1").get(username) as { h: string }).h !== "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-everyday-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [
      ["ada", true],
      ["kim", false],
      ["bea", true],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@x.test`,
        password: PASSWORD,
        isAdmin,
      });
      if (!made.ok) throw new Error(made.error);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin's home asks for an everyday account and says why; anyone else's does not", async () => {
    const admin = await page(await signIn("ada"), "/");
    expect(admin).toContain("Make your everyday account");
    expect(admin).toContain(WHY);
    expect(admin).toContain('value="ada-me"');
    expect(admin).toContain("Keep using admin");
    expect(admin).not.toContain("everyday-ask");
    expect(await page(await signIn("kim"), "/")).not.toContain(
      "Make your everyday account",
    );
  });

  test("only an admin, from this forge's own pages, can make one", async () => {
    const kim = await signIn("kim");
    const refused = await post(kim, "/settings/everyday", {
      username: "kim-me",
      email: "kim-me@x.test",
    });
    expect(refused.status).toBe(403);
    const asked = await fetch(url("/settings/everyday/options"), {
      method: "POST",
      headers: { cookie: kim, origin: servers.url, "content-type": "application/json" },
      body: JSON.stringify({ username: "kim-me", email: "kim-me@x.test" }),
    });
    expect(asked.status).toBe(403);
    const root = await signIn("ada");
    const crossed = await post(
      root,
      "/settings/everyday",
      { username: "x-me", email: "x@x.test" },
      "https://evil.test",
    );
    expect(crossed.status).toBe(403);
    expect(getUserByName(app.db, "kim-me")).toBeUndefined();
    expect(getUserByName(app.db, "x-me")).toBeUndefined();
  });

  test("a password and no passkey, or a taken name, makes nothing", async () => {
    const root = await signIn("ada");
    const refused = await post(root, "/settings/everyday", {
      username: "ada-me",
      email: "me@x.test",
      password: PASSWORD,
    });
    expect(refused.status).toBe(303);
    const flash = (refused.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await page(`${root}; ${flash}`, "/")).toContain("Passwords are not taken here.");
    // A taken name is refused before any key is made.
    const asked = await fetch(url("/settings/everyday/options"), {
      method: "POST",
      headers: { cookie: root, origin: servers.url, "content-type": "application/json" },
      body: JSON.stringify({ username: "kim", email: "me@x.test" }),
    });
    expect(asked.status).toBe(422);
    expect(await asked.text()).toContain("That username is taken.");
    expect(getUserByName(app.db, "ada-me")).toBeUndefined();
    expect(everydayOf(app.db, getUserByName(app.db, "ada")!)).toBeUndefined();
  });

  test("a reserved name makes nothing (#720): a page's, or another admin's; the admin's own stays theirs", async () => {
    const root = await signIn("ada");
    for (const username of ["settings", "bea-me"]) {
      const res = await make(root, {
        username,
        email: `${username}@x.test`,
      });
      expect(res.status).toBe(303);
      expect(getUserByName(app.db, username)).toBeUndefined();
    }
    expect(everydayOf(app.db, getUserByName(app.db, "ada")!)).toBeUndefined();
  });

  test("Make it: an ordinary account, linked both ways, and the person is signed in as it", async () => {
    const root = await signIn("ada");
    const home = await page(root, "/");
    expect(home).toContain('id="passkey-make"');
    expect(home).not.toContain("passkey-note");
    expect(home).toContain('<span class="muted small" id="passkey-make-note" data-fail="error" role="status"></span>');
    expect(home).not.toContain('name="password"');
    const res = await make(root, {
      username: "ada-me",
      email: "me@x.test",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("forge_session=");
    const daily = getUserByName(app.db, "ada-me")!;
    expect(daily.isAdmin).toBe(false);
    expect(listPasskeys(app.db, daily.id)).toHaveLength(1);
    expect(hasPassword("ada-me")).toBe(false);
    const admin = getUserByName(app.db, "ada")!;
    expect(everydayOf(app.db, admin)?.username).toBe("ada-me");
    expect(adminOf(app.db, daily)?.username).toBe("ada");
    // Signed in as the everyday account now.
    expect(await page(cookie, "/settings")).toContain(
      "This is the everyday account of",
    );
    // The admin is not asked again, and its page names the pair.
    expect(await page(root, "/")).not.toContain("Make your everyday account");
    expect(await page(root, "/settings")).toContain("Your everyday account is");
  });

  test("Keep using admin is recorded; the account page still offers the way, without asking again", async () => {
    const boss = await signIn("bea");
    const res = await post(boss, "/settings/everyday/keep", {});
    expect(res.status).toBe(303);
    expect(keptAdmin(app.db, getUserByName(app.db, "bea")!)).toBe(true);
    expect(await page(boss, "/")).not.toContain("Make your everyday account");
    const settings = await page(boss, "/settings");
    expect(settings).toContain("Make your everyday account");
    expect(settings).not.toContain("Keep using admin");
  });

  test("an admin's token from the page is minted only when they tick that they mean it", async () => {
    const root = await signIn("ada");
    const form = await page(root, "/settings/tokens");
    expect(form).toContain("I mean to give this access code admin");
    const count = () =>
      (
        app.db
          .query("SELECT COUNT(*) AS n FROM token WHERE user_id = ?1")
          .get(getUserByName(app.db, "ada")!.id) as { n: number }
      ).n;
    const before = count();
    await post(root, "/settings/tokens", { name: "laptop", scope: "rw" });
    expect(count()).toBe(before);
    await post(root, "/settings/tokens", {
      name: "laptop",
      scope: "rw",
      aiAdmin: "on",
    });
    expect(count()).toBe(before + 1);
    // Someone who is not an admin is not asked.
    expect(await page(await signIn("kim"), "/settings/tokens")).not.toContain(
      "I mean to give this access code admin",
    );
  });

  test("the token page keeps a member on the page with the sentence for admin scope, and makes rw", async () => {
    const kim = await signIn("kim");
    const count = () =>
      (
        app.db
          .query("SELECT COUNT(*) AS n FROM token WHERE user_id = ?1")
          .get(getUserByName(app.db, "kim")!.id) as { n: number }
      ).n;
    const before = count();
    expect(await page(kim, "/settings/tokens")).not.toContain('value="admin"');
    const denied = await post(kim, "/settings/tokens", { name: "big", scope: "admin" });
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get("location")!, servers.url).pathname).toBe("/settings/tokens");
    const flash = (denied.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(decodeURIComponent(flash.replace(/\+/g, " "))).toContain(ADMIN_TOKEN_WORDS);
    expect(count()).toBe(before);
    await post(kim, "/settings/tokens", { name: "small", scope: "rw" });
    expect(count()).toBe(before + 1);
  });

  test("from a page's session, the API refuses an admin's token without adminConfirm", async () => {
    const root = await signIn("ada");
    const mint = (body: Record<string, unknown>) =>
      fetch(url("/api/v1/tokens"), {
        method: "POST",
        headers: {
          cookie: root,
          origin: servers.url,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const refused = await mint({ name: "ai", scope: "rw" });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("adminConfirm");
    expect(
      (await mint({ name: "ai", scope: "rw", adminConfirm: true })).status,
    ).toBe(201);
  });

  test("an MCP client with an admin's token is told it acts as admin, and where daily work belongs", async () => {
    const init = async (token: string) => {
      const res = await fetch(url("/mcp"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
      });
      return ((await res.json()) as any).result.instructions as string;
    };
    const rootToken = createToken(
      app.db,
      getUserByName(app.db, "ada")!.id,
      "t",
      "ro",
    ).token;
    const kimToken = createToken(
      app.db,
      getUserByName(app.db, "kim")!.id,
      "t",
      "ro",
    ).token;
    const said = await init(rootToken);
    expect(said).toContain("acts as admin");
    expect(said).toContain("ada-me, their everyday account");
    expect(await init(kimToken)).not.toContain("acts as admin");
  });

  test("with the password too, an admin's token needs adminConfirm; anyone else's does not", async () => {
    const mint = (username: string, extra: Record<string, unknown> = {}) =>
      fetch(url("/api/v1/tokens"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: PASSWORD, name: "cli", scope: "ro", ...extra }),
      });
    const refused = await mint("ada");
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("adminConfirm");
    expect((await mint("ada", { adminConfirm: true })).status).toBe(201);
    expect((await mint("kim")).status).toBe(201);
  });

  test("an admin who already has one is shown the way to it: asked again, and on their settings, a sign-in as it", async () => {
    const ada = await signIn("ada");
    const again = await post(ada, "/settings/everyday", { username: "ada-two", email: "two@x.test" });
    expect(again.status).toBe(303);
    const flash = (again.headers.get("set-cookie") ?? "").split(";")[0]!;
    const settings = await page(`${ada}; ${flash}`, again.headers.get("location")!);
    expect(settings).toContain("You already have an everyday account, ada-me");
    expect(settings).toContain('action="/settings/everyday/switch"');
    expect(settings).toContain("Sign in as ada-me");
    // Switching ends this admin session and lands on sign in, saying as whom.
    const switched = await post(ada, "/settings/everyday/switch", {});
    expect(switched.status).toBe(303);
    expect(switched.headers.get("location")).toContain("/signin");
    expect(switched.headers.get("set-cookie") ?? "").toContain("forge_session=;");
    expect((await fetch(url("/settings"), { headers: { cookie: ada }, redirect: "manual" })).status).not.toBe(200);
    // Someone without an everyday account has nothing to switch to.
    const kim = await signIn("kim");
    expect((await post(kim, "/settings/everyday/switch", {})).status).toBe(404);
  });

  test("an everyday account may not take a name the forge reserves", async () => {
    const boss = await signIn("bea");
    await make(boss, { username: "settings", email: "s@x.test" });
    expect(getUserByName(app.db, "settings")).toBeUndefined();
  });

  test("joining an org whose \"Writers\" team grants something else still makes a writer, never more", async () => {
    const mk = async (username: string) => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASSWORD });
      if (!made.ok) throw new Error(username);
      return made.value;
    };
    const org = createOrg(app.db, "shop", (await mk("shopkeeper")).id);
    if (!org.ok) throw new Error("org");
    const readers = createTeam(app.db, org.value.id, WRITERS_TEAM, "read");
    if (!readers.ok) throw new Error("team");
    const daily = await mk("shop-daily");
    expect(joinAsWriter(app.db, org.value, daily)).toBe(true);
    expect(orgAccessByOrg(app.db, daily).get(org.value.id)).toBe("write");
    // The existing team was not widened.
    expect(getTeam(app.db, readers.value.id)?.permission).toBe("read");
    // Asked again, the same team: no second one.
    const teams = listTeams(app.db, org.value.id).length;
    expect(joinAsWriter(app.db, org.value, daily)).toBe(true);
    expect(listTeams(app.db, org.value.id).length).toBe(teams);
  });

  test("when no write team can be had, joinAsWriter says so", async () => {
    const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "stall", email: "stall@x.test", password: PASSWORD });
    if (!owner.ok) throw new Error("owner");
    const org = createOrg(app.db, "stalls", owner.value.id);
    if (!org.ok) throw new Error("org");
    for (const name of [WRITERS_TEAM, "Everyday writers"])
      if (!createTeam(app.db, org.value.id, name, "read").ok) throw new Error(name);
    const daily = await createUser(app.db, { origin: "seed", trusted: true, username: "stall-daily", email: "sd@x.test", password: PASSWORD });
    if (!daily.ok) throw new Error("daily");
    expect(joinAsWriter(app.db, org.value, daily.value)).toBe(false);
    expect(orgAccessByOrg(app.db, daily.value).get(org.value.id)).toBeUndefined();
  });

  // Last: it makes this forge a spawned one (a parent.json naming "stalls").
  test("on a spawned forge, an everyday account that cannot join keeps the admin signed in, sent to the org's teams", async () => {
    const cyd = await createUser(app.db, { origin: "seed", trusted: true, username: "cyd", email: "cyd@x.test", password: PASSWORD, isAdmin: true });
    if (!cyd.ok) throw new Error("cyd");
    await Bun.write(join(dataDir, "parent.json"), JSON.stringify({ org: "stalls" }));
    const admin = await signIn("cyd");
    const res = await make(admin, { username: "cyd-me", email: "cyd-me@x.test" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/stalls#teams");
    // No session for the new account: the admin is still the one signed in.
    expect(res.headers.get("set-cookie") ?? "").not.toContain("forge_session=");
    expect(getUserByName(app.db, "cyd-me")).toBeDefined();
    // The flash rides in its own cookie, next to the admin's session.
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const there = await page(`${admin}; ${flash}`, res.headers.get("location")!);
    expect(there).toContain("cyd-me was made but could not join stalls");
    expect(there).toContain('id="teams"');
  });
});
