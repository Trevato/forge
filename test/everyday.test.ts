/**
 * The everyday account (#596): a forge's admin is asked once, kindly, to
 * make an account apart from admin for daily work; making it signs them in
 * as it, keeping admin is recorded; both account pages name the pair. A
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
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

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
    expect(await page(await signIn("kim"), "/")).not.toContain(
      "Make your everyday account",
    );
  });

  test("only an admin, from this forge's own pages, can make one", async () => {
    const kim = await signIn("kim");
    const refused = await post(kim, "/settings/everyday", {
      username: "kim-me",
      email: "kim-me@x.test",
      password: PASSWORD,
    });
    expect(refused.status).toBe(403);
    const root = await signIn("ada");
    const crossed = await post(
      root,
      "/settings/everyday",
      { username: "x-me", email: "x@x.test", password: PASSWORD },
      "https://evil.test",
    );
    expect(crossed.status).toBe(403);
    expect(getUserByName(app.db, "kim-me")).toBeUndefined();
    expect(getUserByName(app.db, "x-me")).toBeUndefined();
  });

  test("a weak password or a taken name makes nothing", async () => {
    const root = await signIn("ada");
    await post(root, "/settings/everyday", {
      username: "ada-me",
      email: "me@x.test",
      password: "short",
    });
    await post(root, "/settings/everyday", {
      username: "kim",
      email: "me@x.test",
      password: PASSWORD,
    });
    expect(getUserByName(app.db, "ada-me")).toBeUndefined();
    expect(everydayOf(app.db, getUserByName(app.db, "ada")!)).toBeUndefined();
  });

  test("Make it: an ordinary account, linked both ways, and the person is signed in as it", async () => {
    const root = await signIn("ada");
    const res = await post(root, "/settings/everyday", {
      username: "ada-me",
      email: "me@x.test",
      password: PASSWORD,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("forge_session=");
    const daily = getUserByName(app.db, "ada-me")!;
    expect(daily.isAdmin).toBe(false);
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
    expect(form).toContain("I mean to give this token admin");
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
      "I mean to give this token admin",
    );
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

  test("an everyday account may not take a name the forge reserves", async () => {
    const boss = await signIn("bea");
    await post(boss, "/settings/everyday", { username: "settings", email: "s@x.test", password: PASSWORD });
    expect(getUserByName(app.db, "settings")).toBeUndefined();
  });

  test("joining an org whose \"Writers\" team grants something else still makes a writer, never more", async () => {
    const mk = async (username: string) => {
      const made = await createUser(app.db, { trusted: true, username, email: `${username}@x.test`, password: PASSWORD });
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
});
