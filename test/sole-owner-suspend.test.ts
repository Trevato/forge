/**
 * Suspending the last active owner of an organization is said before it is
 * done, and the forge's owner must confirm it (#722's review). An
 * organization left with no active owner stays as it is for its members,
 * and the people it concerns are told: the forge's owner on the accounts
 * page (the person's row and the organization), its members on its page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspendAccount, unsuspendAccount } from "../src/actions/accounts.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { ownerlessOrgs } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("suspending an organization's last active owner", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let olive: User;
  let sam: User;
  let mia: User;
  let acme: User;
  let ownerCookie = "";
  let ownerToken = "";

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const page = async (path: string, cookie: string) =>
    (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const post = (path: string, fields: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: base },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sole-owner-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    olive = await person("olive", true);
    sam = await person("sam");
    mia = await person("mia");
    const org = createOrg(app, sam, "acme");
    if (!org.ok) throw new Error(String(org.error));
    acme = org.value;
    const crew = createTeam(app, sam, acme, "makers", "write");
    if (!crew.ok) throw new Error(String(crew.error));
    expect(addTeamMember(app, sam, acme, crew.value, "mia").ok).toBe(true);
    ownerCookie = `forge_session=${createSession(app.db, olive.id).token}`;
    ownerToken = createToken(app.db, olive.id, "t", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const suspended = () => getUserByName(app.db, "sam")!.suspendedAt !== null;

  test("unconfirmed, it is refused on every route and nothing changes", async () => {
    expect((await suspendAccount(app, olive, "sam")).ok).toBe(false);
    const api = await fetch(`${base}/api/v1/admin/accounts/sam/suspend`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(api.status).toBe(409);
    expect(await api.text()).toContain("acme");
    const web = await post("/settings/accounts/sam/suspend");
    expect(web.status).toBe(409);
    const said = await web.text();
    expect(said).toContain("only active owner of");
    expect(said).toContain("acme");
    expect(said).toContain('name="confirm" value="1"');
    expect(said).toContain("/acme/-/teams/Owners");
    expect(suspended()).toBe(false);
  });

  test("a person who owns nothing alone is suspended without the question", async () => {
    expect((await suspendAccount(app, olive, "mia")).ok).toBe(true);
    expect(unsuspendAccount(app, olive, "mia").ok).toBe(true);
  });

  test("confirmed, it is done, and the organization stays for its members", async () => {
    const web = await post("/settings/accounts/sam/suspend", { confirm: "1" });
    expect(web.status).toBe(303);
    expect(suspended()).toBe(true);
    expect(ownerlessOrgs(app.db).map((o) => o.username)).toEqual(["acme"]);
    // Its members still find it and what it holds.
    const miaCookie = `forge_session=${createSession(app.db, mia.id).token}`;
    const orgPage = await fetch(`${base}/acme`, { headers: { cookie: miaCookie } });
    expect(orgPage.status).toBe(200);
    expect(await orgPage.text()).toContain("Nobody can administer this organization");
  });

  test("the forge's owner is told on the accounts page: the person's row and the organization", async () => {
    const accounts = await page("/settings/accounts", ownerCookie);
    expect(accounts).toContain("acme: no active owner");
    expect(accounts).toContain("has no active owner");
    expect(accounts).toContain('href="/acme/-/teams/Owners"');
    // A stranger is told nothing of it.
    const stranger = await (await fetch(`${base}/acme`)).text();
    expect(stranger).not.toContain("Nobody can administer this organization");
  });

  test("over the API, confirm: true suspends; unsuspending clears the alert", async () => {
    expect(unsuspendAccount(app, olive, "sam").ok).toBe(true);
    expect(ownerlessOrgs(app.db)).toEqual([]);
    const api = await fetch(`${base}/api/v1/admin/accounts/sam/suspend`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirm: true }),
    });
    expect(api.status).toBe(200);
    expect(suspended()).toBe(true);
    expect(unsuspendAccount(app, olive, "sam").ok).toBe(true);
    expect(await page("/settings/accounts", ownerCookie)).not.toContain(
      "has no active owner",
    );
  });
});
