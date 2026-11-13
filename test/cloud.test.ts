/**
 * Cloud accounts: a credential is verified read-only before it is sealed,
 * never listed with its value, every open is a visible read, an audit opens
 * issues and changes nothing, and a run that needs writes is refused while
 * the switch is off.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  addAccount,
  allowWrite,
  auditAccount,
  net,
  removeAccount,
  reverify,
} from "../src/actions/cloud.ts";
import { createRepo } from "../src/actions/repos.ts";
import { verify } from "../src/cloud/providers.ts";
import { listCloudAccounts, recentCloudReads } from "../src/core/cloud_account.ts";
import { listSecretNames } from "../src/core/secret_store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { grantSecrets, parseDeclaration } from "../src/crew/grant.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "do-live-9Zq4TxLm7Kp2Vb8nWcR5";
const calls: { url: string; method: string; auth: string }[] = [];

/** A fake DigitalOcean: records every request, answers like the real API. */
net.fetch = async (url, init) => {
  calls.push({
    url,
    method: init?.method ?? "GET",
    auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
  });
  const bad = !String((init?.headers as any)?.authorization).includes(TOKEN);
  const u = new URL(url);
  const reply = (o: unknown) => new Response(JSON.stringify(o), { status: bad ? 401 : 200 });
  if (u.pathname === "/v2/account") return reply({ account: { email: "o@x.test", status: "active" } });
  if (u.pathname === "/v2/projects") return reply({ projects: [{}, {}] });
  if (u.pathname === "/v2/droplets") return reply({ meta: { total: 3 }, droplets: [{ name: "old", status: "off", size_slug: "s-2vcpu-4gb", size: { price_monthly: 24 } }] });
  if (u.pathname === "/v2/volumes") return reply({ volumes: [{ name: "vol1", size_gigabytes: 100, region: { slug: "nyc1" }, droplet_ids: [] }, { name: "vol2", size_gigabytes: 10, droplet_ids: [1] }] });
  if (u.pathname === "/v2/reserved_ips") return reply({ reserved_ips: [] });
  return new Response("{}", { status: 404 });
};

describe("cloud accounts", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repoId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cloud-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.test", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.test", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    const r = await createRepo(app, alice, { name: "ops", visibility: "private" });
    if (!r.ok) throw new Error("repo");
    repoId = r.value.id;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a rejected credential is not stored; only admins may add", async () => {
    expect((await addAccount(app, alice, "digitalocean", "main", "wrong-token-123")).ok).toBe(false);
    expect(listCloudAccounts(app.db)).toEqual([]);
    expect(listSecretNames(app.db, "forge")).toEqual([]);
    const denied = await addAccount(app, bob, "digitalocean", "main", TOKEN);
    expect(denied).toEqual({ ok: false, error: "not_found" });
    expect((await addAccount(app, alice, "nope", "main", TOKEN)).ok).toBe(false);
    expect((await addAccount(app, alice, "digitalocean", "Bad Name", TOKEN)).ok).toBe(false);
  });

  test("verify then seal: one sentence, only GETs, value never listed", async () => {
    calls.length = 0;
    const r = await addAccount(app, alice, "digitalocean", "main", TOKEN);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toContain("o@x.test");
    expect(r.ok && r.value).toContain("2 projects");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(listSecretNames(app.db, "forge").map((s) => s.name)).toEqual(["CLOUD_DIGITALOCEAN_MAIN"]);
    const [acct] = listCloudAccounts(app.db);
    expect(acct).toMatchObject({ provider: "digitalocean", name: "main", writeAllowed: false });
    expect(JSON.stringify(acct)).not.toContain(TOKEN);
  });

  test("a re-verify and an audit are visible reads naming their run", async () => {
    expect((await reverify(app, alice, "digitalocean", "main")).ok).toBe(true);
    expect((await reverify(app, bob, "digitalocean", "main")).ok).toBe(false);
    const done = await auditAccount(app, alice, "digitalocean", "main", "alice/ops");
    expect(done).toEqual({ ok: true, value: { opened: 2, found: 2 } });
    const runs = recentCloudReads(app.db).map((r) => r.run ?? "");
    expect(runs.some((x) => x === "verify:digitalocean")).toBe(true);
    expect(runs.some((x) => x.startsWith("audit:digitalocean:"))).toBe(true);
    expect(JSON.stringify(recentCloudReads(app.db))).not.toContain(TOKEN);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("an audit files one issue per finding, with the saving, and does not duplicate", async () => {
    const titles = app.db
      .query<{ title: string; body: string }, [string]>("SELECT title, body FROM issue WHERE repo_id = ?1 ORDER BY number")
      .all(repoId);
    expect(titles.map((t) => t.title)).toEqual([
      "[audit] DigitalOcean: unattached volume vol1",
      "[audit] DigitalOcean: powered-off droplet old",
    ]);
    expect(titles[0]!.body).toContain("$10.00 a month");
    expect(titles[1]!.body).toContain("$24.00 a month");
    const again = await auditAccount(app, alice, "digitalocean", "main", "alice/ops");
    expect(again).toEqual({ ok: true, value: { opened: 0, found: 2 } });
    expect((await auditAccount(app, alice, "digitalocean", "main", "alice/missing")).ok).toBe(false);
  });

  test("a run that needs writes is refused while the switch is off, and says so", () => {
    const run = { id: "r1", repoId, ownerId: alice.id, actorId: alice.id };
    const reads = () => recentCloudReads(app.db).length;
    const before = reads();
    const refused = grantSecrets(app.db, dataDir, app.bus, parseDeclaration("---\nsecrets: CLOUD_DIGITALOCEAN_MAIN\nwrites: yes\n---"), run);
    expect(refused.writeRefused).toEqual(["CLOUD_DIGITALOCEAN_MAIN"]);
    expect(refused.env).toEqual({});
    expect(reads()).toBe(before);

    // Read-only runs are the default and get it.
    const ro = grantSecrets(app.db, dataDir, app.bus, parseDeclaration("---\nsecrets: CLOUD_DIGITALOCEAN_MAIN\n---"), { ...run, id: "r2" });
    expect(ro.names).toEqual(["CLOUD_DIGITALOCEAN_MAIN"]);
    ro.release();

    expect(allowWrite(app, bob, "digitalocean", "main", true).ok).toBe(false);
    expect(allowWrite(app, alice, "digitalocean", "main", true).ok).toBe(true);
    const rw = grantSecrets(app.db, dataDir, app.bus, parseDeclaration("---\nsecrets: CLOUD_DIGITALOCEAN_MAIN\nwrites: yes\n---"), { ...run, id: "r3" });
    expect(rw.writeRefused).toEqual([]);
    expect(rw.names).toEqual(["CLOUD_DIGITALOCEAN_MAIN"]);
    rw.release();
    allowWrite(app, alice, "digitalocean", "main", false);
  });

  test("the page shows names and reads, never the value, and only to admins", async () => {
    const login = async (username: string) =>
      ((await fetch(`${servers.url}/signin`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
        body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const get = async (c: string) => fetch(`${servers.url}/settings/cloud`, { headers: { cookie: c } });
    const page = await (await get(await login("alice"))).text();
    expect(page).toContain("Cloud accounts");
    expect(page).toContain("DigitalOcean");
    expect(page).toContain("verify");
    expect(page).toContain("read-only");
    expect(page).not.toContain(TOKEN);
    expect((await get(await login("bob"))).status).toBe(403);
    const cross = await fetch(`${servers.url}/settings/cloud/write`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: await login("alice"), "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ provider: "digitalocean", name: "main", allowed: "1" }),
    });
    expect(cross.status).toBe(403);
    expect(listCloudAccounts(app.db)[0]!.writeAllowed).toBe(false);
  });

  test("remove drops the sealed value and the row", () => {
    expect(removeAccount(app, bob, "digitalocean", "main").ok).toBe(false);
    expect(removeAccount(app, alice, "digitalocean", "main").ok).toBe(true);
    expect(listCloudAccounts(app.db)).toEqual([]);
    expect(listSecretNames(app.db, "forge")).toEqual([]);
  });
});

describe("providers", () => {
  test("backblaze reports the key's own capabilities, and that it can write", async () => {
    const f = async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("authorize")
            ? { apiUrl: "https://api001.backblazeb2.com", accountId: "a", authorizationToken: "t", allowed: { capabilities: ["listBuckets", "writeFiles"] } }
            : { buckets: [{}] },
        ),
      );
    const r = await verify("backblaze", "id:key", f);
    expect(r.ok && r.value.canWrite).toBe(true);
    expect(r.ok && r.value.summary).toContain("CAN write");
  });

  test("backblaze refuses an api host outside backblazeb2.com", async () => {
    const f = async () => new Response(JSON.stringify({ apiUrl: "https://evil.example", allowed: {} }));
    expect((await verify("backblaze", "id:key", f)).ok).toBe(false);
  });

  test("aws signs a GetCallerIdentity and reads the account", async () => {
    let seen: { url: string; auth: string; body: string } | undefined;
    const f = async (url: string, init?: RequestInit) => {
      seen = { url, auth: String((init?.headers as any).authorization), body: String(init?.body) };
      return new Response("<Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/ro</Arn>");
    };
    const r = await verify("aws", "AKIDEXAMPLE:secret", f);
    expect(r.ok && r.value.summary).toContain("user/ro");
    expect(seen!.url).toBe("https://sts.amazonaws.com/");
    expect(seen!.body).toBe("Action=GetCallerIdentity&Version=2011-06-15");
    expect(seen!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  test("a malformed multi-part credential is refused before any request", async () => {
    let n = 0;
    const f = async () => (n++, new Response("{}"));
    expect((await verify("aws", "no-colon", f)).ok).toBe(false);
    expect((await verify("azure", "a:b", f)).ok).toBe(false);
    expect(n).toBe(0);
  });
});
