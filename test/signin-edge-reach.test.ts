/**
 * The forge's own sign-in reach (#9432): the admin sees who signs in without
 * the edge, a dry run names who switching it off would lock out (and refuses
 * the admin themselves), and a passkey added in a browser the edge signed in
 * links the edge login to that account without making another.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { edgeOffDryRun } from "../src/actions/capacity.ts";
import { signinReach, signsInWithoutEdge } from "../src/core/accounts.ts";
import { capacityValue } from "../src/core/capacity.ts";
import { createSession } from "../src/core/sessions.ts";
import { entry, edgeOnlyScreen } from "../src/tui/screens/edgeonly.ts";
import { linkedLogin } from "../src/core/edge_links.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { device } from "./helpers/passkey.ts";

const TOKEN = "edge-secret-0123456789";

describe("signin reach", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const asAda = { "x-plat-user": "ada", "x-plat-edge-token": TOKEN };
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reach-"));
    app = createApp({ dataDir, port: 0, edgeToken: TOKEN });
    servers = await serve(app);
    base = servers.url;
    for (const [username, password] of [["olive", "correct horse battery"], ["ada", undefined]] as const) {
      const made = await seedAdmin(app, { username, email: `${username}@forge.example`, ...(password ? { password } : {}) });
      if (!made.ok) throw new Error(made.error);
    }
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("counts who signs in without the edge, and names who cannot", () => {
    const reach = signinReach(app.db);
    expect(reach.total).toBe(2);
    expect(reach.own).toBe(1);
    expect(reach.stranded.map((a) => a.username)).toEqual(["ada"]);
  });

  test("the dry run lists the lockout, refuses an admin with no way in, and changes nothing", async () => {
    const ada = getUserByName(app.db, "ada")!;
    const dry = edgeOffDryRun(app.db, ada);
    expect(dry.ok && dry.value.youLockedOut).toBe(true);
    expect(dry.ok && dry.value.lockedOut.map((a) => a.username)).toEqual(["ada"]);
    const over = await fetch(`${base}/api/v1/admin/capacity/signin.edge`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base, ...asAda },
      body: JSON.stringify({ value: "off", dry_run: true }),
    });
    expect(over.status).toBe(200);
    expect(await over.json()).toMatchObject({ dry_run: true, allowed: false, own: 1, total: 2 });
    expect(edgeOffDryRun(app.db, getUserByName(app.db, "olive")!)).toMatchObject({ ok: true, value: { allowed: true } });
    const stranger = edgeOffDryRun(app.db, undefined);
    expect(stranger.ok).toBe(false);
  });

  test("the accounts page says how many sign in without the edge", async () => {
    const page = await (await fetch(`${base}/settings/accounts`, { headers: asAda })).text();
    expect(page).toContain("1 of 2 accounts can sign in without the platform edge");
  });

  test("a passkey added through the edge links the login, makes no account, and covers the account", async () => {
    const page = await (await fetch(`${base}/settings/passkeys`, { headers: asAda })).text();
    expect(page).toContain('id="passkey-why"');
    const key = await device(new URL(base).origin);
    const opts = (await (await post("/settings/passkeys/options", {}, asAda)).json()) as { challenge: string };
    const added = await post("/settings/passkeys", { name: "laptop", challenge: opts.challenge, ...(await key.create(opts.challenge)) }, asAda);
    expect(added.status).toBe(200);
    const ada = getUserByName(app.db, "ada")!;
    expect(linkedLogin(app.db, ada.id)).toBe("ada");
    expect(signinReach(app.db)).toMatchObject({ total: 2, own: 2, stranded: [] });
  });
});

describe("the dry run changes nothing, on every door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let adaCookie: string;
  let bobCookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-dry-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);
    const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "bobby@forge.example", password: "correct horse battery" });
    if (!bob.ok) throw new Error(bob.error);
    adaCookie = `forge_session=${createSession(app.db, getUserByName(app.db, "ada")!.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const put = (key: string, body: unknown, cookie: string) =>
    fetch(`${base}/api/v1/admin/capacity/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify(body),
    });

  test("dry_run on a key with no dry run is refused and writes nothing", async () => {
    const key = "signin.edge";
    const other = (await (await fetch(`${base}/api/v1/admin/capacity`, { headers: { cookie: adaCookie } })).json() as { items: { key: string }[] }).items.find((i) => i.key !== key)!.key;
    const before = capacityValue(app.db, other as never);
    const res = await put(other, { value: "1", dry_run: true }, adaCookie);
    expect(res.status).toBe(404);
    expect(capacityValue(app.db, other as never)).toBe(before);
    const after = await fetch(`${base}/api/v1/admin/capacity`, { headers: { cookie: adaCookie } });
    expect(JSON.stringify(await after.json())).not.toContain('"changed"');
  });

  test("a non-admin is refused the dry run", async () => {
    const res = await put("signin.edge", { dry_run: true }, bobCookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toContain("locked");
  });

  test("the Capacity page's Dry run button flashes the verdict, and a locked-out admin cannot then switch the edge off", async () => {
    const form = (extra: Record<string, string>) =>
      fetch(`${base}/settings/capacity`, {
        method: "POST",
        headers: { origin: base, cookie: adaCookie },
        body: new URLSearchParams({ key: "signin.edge", ...extra }),
        redirect: "manual",
      });
    const dry = await form({ dry: "1", value: "off" });
    expect(dry.status).toBe(303);
    const seen = await fetch(new URL(dry.headers.get("location")!, base), {
      headers: { cookie: `${adaCookie}; ${(dry.headers.get("set-cookie") ?? "").split(";")[0]}` },
    });
    const page = await seen.text();
    expect(page).toContain("accounts sign in without the edge");
    expect(page).toContain("ada (admin)");
    expect(page).toContain("You would be too");
    expect(page).toMatch(/danger/);
    expect(capacityValue(app.db, "signin.edge")).not.toBe("off");
    const refused = await form({ value: "off" });
    expect(refused.status).not.toBe(200);
    expect(capacityValue(app.db, "signin.edge")).not.toBe("off");
  });

  test("the refusal and the lists agree: a federated identity or a password counts as a way in", () => {
    const ada = getUserByName(app.db, "ada")!;
    expect(signsInWithoutEdge(app.db, ada.id)).toBe(false);
    app.db.run("UPDATE user SET password_hash = 'x' WHERE id = ?1", [ada.id]);
    expect(signsInWithoutEdge(app.db, ada.id)).toBe(true);
    expect(signinReach(app.db).stranded.map((a) => a.username)).not.toContain("ada");
    const dry = edgeOffDryRun(app.db, getUserByName(app.db, "ada")!);
    expect(dry.ok && dry.value.youLockedOut).toBe(false);
  });

  test("the terminal screen gates admin and guest like the page, and names who the page names", () => {
    app.db.run("UPDATE user SET password_hash = '' WHERE username = 'ada'");
    const ada = getUserByName(app.db, "ada")!;
    const bob = getUserByName(app.db, "bobby")!;
    const session = (user: unknown) => ({ user, db: app.db }) as never;
    expect(entry.offered(session(ada))).toBe(true);
    expect(entry.offered(session(bob))).toBe(false);
    expect(entry.offered(session(undefined))).toBe(false);
    const ctx = { theme: { c: {} } } as never;
    const screen = edgeOnlyScreen(session(ada), ctx);
    expect(screen.title).toBe("Edge-only accounts");
    const names = signinReach(app.db).stranded.map((a) => a.username);
    const dry = edgeOffDryRun(app.db, ada);
    expect(dry.ok && dry.value.lockedOut.map((a) => a.username)).toEqual(names);
    expect(edgeOffDryRun(app.db, bob).ok).toBe(false);
    expect(edgeOffDryRun(app.db, undefined).ok).toBe(false);
  });
});
