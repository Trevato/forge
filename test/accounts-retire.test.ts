import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("accounts: the confirm page for removing an organization too", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let admin: { authorization: string };
  let other: { authorization: string };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-retire-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: "e" });
    servers = await serve(app);
    base = servers.url;
    const mk = async (username: string) => {
      const u = await signUp(app, {
        username,
        email: `${username}@f.dev`,
        password: "a-long-passphrase",
      }, { slot: fixtureSlot(app) });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const made = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "a-long-passphrase" });
    if (!made.ok) throw new Error(made.error);
    const owner = made.value;
    await mk("nosy");
    mkUser = mk;
    proveAll(app);
    admin = { authorization: `Bearer ${createToken(app.db, owner.id, "t", "admin").token}` };
    const nosy = getUserByName(app.db, "nosy")!;
    other = { authorization: `Bearer ${createToken(app.db, nosy.id, "t", "admin").token}` };
  });

  let mkUser: (name: string) => Promise<{ id: string }>;
  /** A person who alone owns `<name>co`, which holds one repository. */
  const seed = async (name: string) => {
    const u = await mkUser(name);
    proveAll(app);
    const org = createOrg(app.db, `${name}co`, u.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "<img src=x onerror=alert(1)>", "read");
    if (!team.ok) throw new Error(team.error);
    const made = await createRepo(app, org.value, { name: "ledger" });
    if (!made.ok) throw new Error(made.error);
  };
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (name: string, headers: Record<string, string>) =>
    fetch(`${base}/settings/accounts/${name}/retire`, {
      method: "POST",
      redirect: "manual",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirm: "1" }).toString(),
    });

  test("the last_owner refusal links to the confirm page", async () => {
    await seed("ra");
    const res = await fetch(`${base}/settings/accounts/ra/remove`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('href="/settings/accounts/ra/retire"');
  });

  test("the suspend refusal links to the confirm page", async () => {
    await seed("rs");
    const res = await fetch(`${base}/settings/accounts/rs/suspend`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('href="/settings/accounts/rs/retire"');
  });

  test("another admin or yourself is told so, not that nothing was found", async () => {
    await mkUser("rg");
    app.db.query("UPDATE user SET is_admin = 1 WHERE username = 'rg'").run();
    const get = await fetch(`${base}/settings/accounts/rg/retire`, {
      headers: admin,
      redirect: "manual",
    });
    expect(get.status).toBe(303);
    expect((await post("olive", admin)).status).toBe(303);
    expect(getUserByName(app.db, "olive")?.removedAt).toBeNull();
  });

  test("a visit lists the organization, repositories and teams, and removes nothing", async () => {
    await seed("rb");
    const res = await fetch(`${base}/settings/accounts/rb/retire`, { headers: admin });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("rbco");
    expect(body).toContain("rbco/ledger");
    expect(body).toContain("Owners");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img");
    expect(existsSync(repoDir(app.reposRoot, "rbco", "ledger"))).toBe(true);
    expect(getUserByName(app.db, "rb")?.removedAt).toBeNull();
    expect(getUserByName(app.db, "rbco")?.removedAt).toBeNull();
  });

  test("a non-admin and a cross-origin post are refused, changing nothing", async () => {
    await seed("rc");
    expect((await fetch(`${base}/settings/accounts/rc/retire`, { headers: other })).status).toBe(403);
    expect((await post("rc", other)).status).toBe(403);
    expect((await post("rc", { ...admin, origin: "https://evil.example" })).status).toBe(403);
    expect(getUserByName(app.db, "rc")?.removedAt).toBeNull();
    expect(existsSync(repoDir(app.reposRoot, "rcco", "ledger"))).toBe(true);
  });

  test("an unconfirmed post removes nothing; a confirmed one says what went", async () => {
    await seed("rd");
    const bare = await fetch(`${base}/settings/accounts/rd/retire`, {
      method: "POST",
      redirect: "manual",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(bare.status).toBe(303);
    expect(getUserByName(app.db, "rd")?.removedAt).toBeNull();
    const done = await post("rd", admin);
    expect(done.status).toBe(200);
    const body = await done.text();
    expect(body).toContain("rdco/ledger");
    expect(body).toContain("Removed");
    expect(getUserByName(app.db, "rd")?.removedAt).not.toBeNull();
    expect(getUserByName(app.db, "rdco")?.removedAt).not.toBeNull();
  });

  test("a removal that stops partway names what failed and what went; again finishes", async () => {
    await seed("re");
    const org = getUserByName(app.db, "reco")!;
    const made = await createRepo(app, org as never, { name: "second" });
    if (!made.ok) throw new Error(made.error);
    const [first, second] = listReposOwnedBy(app.db, org.id).map((r) => r.name) as [string, string];
    const dir = repoDir(app.reposRoot, "reco", second);
    renameSync(dir, `${dir}.parked`);

    const failed = await post("re", admin);
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(body).toContain(`reco/${second}`);
    expect(body).toContain("Removed so far");
    expect(body).toContain(`reco/${first}`);
    expect(body).toContain("Try again");
    expect(getUserByName(app.db, "re")?.removedAt).toBeNull();

    const again = await post("re", admin);
    expect(again.status).toBe(200);
    expect(getUserByName(app.db, "reco")?.removedAt).not.toBeNull();
    expect(getUserByName(app.db, "re")?.removedAt).not.toBeNull();
  });

  test("with no organization of their own, the lead sentence says only the account goes", async () => {
    await mkUser("rf");
    const res = await fetch(`${base}/settings/accounts/rf/retire`, { headers: admin });
    const body = await res.text();
    expect(body).toContain("removes only the account");
    expect(body).not.toContain("alone own, with");
  });

  test("a person's own repository is named, and the lead no longer says only the account", async () => {
    await mkUser("rh");
    proveAll(app);
    promote(app.db, getUserByName(app.db, "rh")!);
    const made = await createRepo(app, getUserByName(app.db, "rh")!, { name: "notes" });
    if (!made.ok) throw new Error(made.error);
    const res = await fetch(`${base}/settings/accounts/rh/retire`, { headers: admin });
    const body = await res.text();
    expect(body).toContain("rh/notes");
    expect(body).not.toContain("removes only the account");
    expect(body).toContain("they own");
  });
});
