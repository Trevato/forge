/** Removing a member from a team asks first, on the confirm page, which names the person and what they lose (#7980). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg } from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, listTeamMembers, listTeams, OWNERS_TEAM, type Team } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("Remove on a team page goes through the confirm page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  let owners: Team;
  let soloOwners: Team;
  const confirmHref = (to: string) => `/-/confirm?to=${encodeURIComponent(to)}`;
  const get = (path: string) => fetch(`${servers.url}${path}`, { redirect: "manual", headers: { cookie } });
  const post = (path: string) =>
    fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin: servers.url } });
  const members = (team: Team) => listTeamMembers(app.db, team.id).map((u) => u.username).sort();
  const person = async (name: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: name === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const ownersOf = (org: User) => listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-team-remove-"));
    app = createApp({ dataDir, port: 0 });
    const alice = await person("alice");
    const bob = await person("bob");
    proveAll(app);
    const acme = createOrg(app, alice, "acme");
    if (!acme.ok) throw new Error(acme.error);
    owners = ownersOf(acme.value);
    expect(addTeamMember(app.db, owners, bob.id)).toBe(true);
    const solo = createOrg(app, alice, "solo");
    if (!solo.ok) throw new Error(solo.error);
    soloOwners = ownersOf(solo.value);
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    servers = await serve(app);
  }, 60_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the team page links Remove to the confirm page, not a form that posts at once", async () => {
    const page = await (await get(`/acme/-/teams/${owners.id}`)).text();
    const to = `/acme/-/teams/${owners.id}/remove?user=bob`;
    expect(page).toContain(`href="${confirmHref(to)}"`);
    expect(page).toContain("remove%3Fuser%3Dbob");
    expect(page).not.toContain(`action="/acme/-/teams/${owners.id}/remove"`);
  });

  test("the confirm page names the person and what they lose, and posts to the path", async () => {
    const to = `/acme/-/teams/${owners.id}/remove?user=bob`;
    const res = await get(confirmHref(to));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Remove @bob from this team?");
    expect(body).toContain("They lose whatever access this team grants them in acme. Their account is untouched.");
    expect(body).toContain(`action="/acme/-/teams/${owners.id}/remove?user=bob"`);
    expect(body).toContain("Remove from team");
    expect(members(owners)).toEqual(["alice", "bob"]);
  });

  test("a crafted query is not a target the confirm page words", async () => {
    const res = await get(confirmHref(`/acme/-/teams/${owners.id}/remove?user=bob&next=x`));
    expect(res.status).toBe(404);
  });

  test("the POST from the confirm page removes the member", async () => {
    const res = await post(`/acme/-/teams/${owners.id}/remove?user=bob`);
    expect(res.status).toBe(303);
    expect(members(owners)).toEqual(["alice"]);
  });

  test("the last owner is still refused", async () => {
    const res = await post(`/solo/-/teams/${soloOwners.id}/remove?user=alice`);
    expect(res.status).toBe(303);
    expect(members(soloOwners)).toEqual(["alice"]);
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await fetch(`${servers.url}${res.headers.get("location")}`, { headers: { cookie: `${cookie}; ${flash}` } });
    expect(await back.text()).toContain("must keep at least one person who owns solo");
  });
});
