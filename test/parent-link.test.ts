/**
 * Linking the parent forge from account settings (#2906): a signed-in
 * person runs the round trip and the callback writes the federated_identity
 * row for their own account, never a new one.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { linkedParent } from "../src/core/federation.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
// Each test is a few round trips between two servers; a loaded check machine outruns bun's 5 s default.
setDefaultTimeout(30_000);

describe("link the parent forge from settings", () => {
  const dirs: string[] = [];
  let parent: App;
  let child: App;
  let parentServers: Servers;
  let childServers: Servers;
  let issuer = "";
  let aliceCookie = "";
  let carolId = "";
  let carolCookie = "";
  let dougId = "";
  let dougCookie = "";

  const cookieOf = (res: Response, name: string) =>
    res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`));

  /** The person with `parentCookie` at the parent consents to the round trip `who` began at the child. */
  const link = async (who: string, parentCookie: string, extra: Record<string, string> = {}) => {
    const start = await fetch(`${childServers.url}/settings/parent/link`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: who, origin: childServers.url, ...extra },
      body: "",
    });
    if (start.status !== 303) return { start } as const;
    const to = new URL(start.headers.get("location")!);
    const state = cookieOf(start, "forge_rp")!;
    const consent = await fetch(`${parentServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: parentCookie, origin: parentServers.url },
      body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
    });
    const callback = new URL(consent.headers.get("location")!);
    return { start, callback, state } as const;
  };
  const finish = (callback: URL, cookie: string) =>
    fetch(`${childServers.url}${callback.pathname}${callback.search}`, { redirect: "manual", headers: { cookie } });
  const users = (app: App) => (app.db.query("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n;

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-plink-"));
      dirs.push(dir);
      return dir;
    };
    parent = createApp({ dataDir: await make(), port: 0 });
    parentServers = await serve(parent);
    child = createApp({ dataDir: await make(), port: 0, parentUrl: parentServers.url, parentLoopback: true });
    childServers = await serve(child);
    issuer = new URL(parentServers.url).origin;
    const mk = async (app: App, username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, { origin: "seed", username, email: `${username}@x.local`, password: "a-long-family-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return { id: made.value.id, cookie: `forge_session=${createSession(app.db, made.value.id).token}` };
    };
    aliceCookie = (await mk(parent, "alice", true)).cookie;
    await mk(child, "olive", true);
    ({ id: carolId, cookie: carolCookie } = await mk(child, "carol"));
    ({ id: dougId, cookie: dougCookie } = await mk(child, "doug"));
    // Four argon2 hashes and two servers: on a loaded check machine that outruns bun's 5 s hook default.
  }, 60_000);
  afterAll(async () => {
    parentServers.stop();
    childServers.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("settings offer Link, and the round trip links the signed-in account without making one", async () => {
    const before = await (await fetch(`${childServers.url}/settings`, { headers: { cookie: carolCookie } })).text();
    expect(before).toContain("not linked");
    expect(before).toContain("/settings/parent/link");
    const users0 = users(child);
    const trip = await link(carolCookie, aliceCookie);
    const done = await finish(trip.callback!, `${carolCookie}; ${trip.state}`);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings");
    expect(linkedParent(child.db, carolId, issuer)).toBeDefined();
    expect(users(child)).toBe(users0);
    const after = await (await fetch(`${childServers.url}/settings`, { headers: { cookie: carolCookie } })).text();
    expect(after).not.toContain("not linked");
    expect(after).toContain(`/-/confirm?to=${encodeURIComponent("/settings/parent/unlink")}`);
  });

  test("a linked person then signs in through the parent as the same account", async () => {
    const start = await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" });
    const to = new URL(start.headers.get("location")!);
    const consent = await fetch(`${parentServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: aliceCookie, origin: parentServers.url },
      body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
    });
    const callback = new URL(consent.headers.get("location")!);
    const users0 = users(child);
    const done = await finish(callback, cookieOf(start, "forge_rp")!);
    expect(done.status).toBe(303);
    expect(users(child)).toBe(users0);
  });

  test("a parent identity another account holds cannot be linked", async () => {
    const users0 = users(child);
    const trip = await link(dougCookie, aliceCookie);
    const done = await finish(trip.callback!, `${dougCookie}; ${trip.state}`);
    expect(done.status).toBe(303);
    expect(linkedParent(child.db, dougId, issuer)).toBeUndefined();
    expect(users(child)).toBe(users0);
  });

  test("a link finished signed out or by another account links nothing", async () => {
    const unlinked = child.db.query("SELECT COUNT(*) AS n FROM federated_identity").get();
    const trip = await link(dougCookie, aliceCookie);
    // Signed out: the state cookie alone does not link.
    const out = await finish(trip.callback!, trip.state!);
    expect(out.status).toBe(403);
    const again = await link(dougCookie, aliceCookie);
    const other = await finish(again.callback!, `${carolCookie}; ${again.state}`);
    expect(other.status).toBe(403);
    expect(linkedParent(child.db, dougId, issuer)).toBeUndefined();
    expect(child.db.query("SELECT COUNT(*) AS n FROM federated_identity").get()).toEqual(unlinked);
  });

  test("a cross-origin or signed-out link start is refused", async () => {
    const cross = await fetch(`${childServers.url}/settings/parent/link`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: carolCookie, origin: "https://evil.example" },
      body: "",
    });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    const out = await fetch(`${childServers.url}/settings/parent/link`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: childServers.url },
      body: "",
    });
    expect(out.headers.get("location") ?? "").not.toContain("/oauth/authorize");
  });

  test("a second identity for an account that already has one is refused", async () => {
    child.db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, 'someone-else', ?2)").run(issuer, dougId);
    const trip = await link(dougCookie, aliceCookie);
    const done = await finish(trip.callback!, `${dougCookie}; ${trip.state}`);
    expect(done.status).toBe(303);
    expect(linkedParent(child.db, dougId, issuer)).toBe("someone-else");
    child.db.query("DELETE FROM federated_identity WHERE user_id = ?1").run(dougId);
  });

  test("Unlink is refused when the link is the account's only way in", async () => {
    const mkId = child.db.query("SELECT id FROM user WHERE username = 'carol'").get() as { id: string };
    child.db.query("UPDATE user SET password_hash = '' WHERE id = ?1").run(mkId.id);
    child.db.query("DELETE FROM federated_identity WHERE user_id = ?1").run(mkId.id);
    child.db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, 'carol-sub', ?2)").run(issuer, mkId.id);
    const res = await fetch(`${childServers.url}/settings/parent/unlink`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: carolCookie, origin: childServers.url },
      body: "",
    });
    expect(res.status).toBe(303);
    expect(linkedParent(child.db, mkId.id, issuer)).toBe("carol-sub");
    const page = await (await fetch(`${childServers.url}/settings`, { headers: { cookie: carolCookie } })).text();
    expect(page).not.toContain("not linked");
    child.db.query("UPDATE user SET password_hash = 'x' WHERE id = ?1").run(mkId.id);
  });

  test("Unlink removes the link; a forge with no parent shows no line", async () => {
    const res = await fetch(`${childServers.url}/settings/parent/unlink`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: carolCookie, origin: childServers.url },
      body: "",
    });
    expect(res.status).toBe(303);
    expect(linkedParent(child.db, carolId, issuer)).toBeUndefined();
    const none = await (await fetch(`${parentServers.url}/settings`, { headers: { cookie: aliceCookie } })).text();
    expect(none).not.toContain("/settings/parent/link");
  });
});
