/**
 * Cloud accounts, step 2 (#2177): attach, rotate, rename and remove a token
 * sealed; no page shows it; every vendor call is gated and audited; an
 * undeclared one never reaches the network; the audit keeps 90 days.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  addAccount,
  net,
  removeAccount,
  renameAccount,
  rotateAccount,
} from "../src/actions/cloud.ts";
import { createRepo } from "../src/actions/repos.ts";
import { usedFor } from "../src/cloud/declared.ts";
import { bar, gatedFetch, handOut } from "../src/cloud/gate.ts";
import { PROVIDERS, VENDOR_OF } from "../src/cloud/providers.ts";
import { CLOUD_VENDORS } from "../src/apps/manifest.ts";
import { grantSecrets, parseDeclaration } from "../src/crew/grant.ts";
import { auditToday, pruneAudit, recordAudit } from "../src/core/cloud_audit.ts";
import { listCloudAccounts } from "../src/core/cloud_account.ts";
import { listSecretNames, setSecret } from "../src/core/secret_store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T1 = "ghp_first9Zq4TxLm7Kp2Vb8nWcR5";
const T2 = "ghp_second7Hs3DfGj6Lm1Qw0Zx8";
const seen: string[] = [];

net.fetch = async (url, init) => {
  seen.push(url);
  const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
  const good = auth.includes(T1) || auth.includes(T2);
  return new Response(JSON.stringify({ login: "octo" }), { status: good ? 200 : 401 });
};

describe("cloud gate", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repoId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cloud-gate-"));
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

  test("attach, rotate, rename, remove — admin only, audited, sealed", async () => {
    expect((await addAccount(app, bob, "github", "main", T1)).ok).toBe(false);
    const added = await addAccount(app, alice, "github", "main", T1);
    expect(added.ok && added.value).toContain("octo");
    expect(listSecretNames(app.db, "forge").map((s) => s.name)).toEqual(["CLOUD_GITHUB_MAIN"]);

    expect((await rotateAccount(app, alice, "github", "main", "bad-token-value")).ok).toBe(false);
    expect((await rotateAccount(app, alice, "github", "nope", T2)).ok).toBe(false);
    expect((await rotateAccount(app, alice, "github", "main", T2)).ok).toBe(true);

    expect(renameAccount(app, bob, "github", "main", "work").ok).toBe(false);
    expect(renameAccount(app, alice, "github", "main", "work").ok).toBe(true);
    expect(listCloudAccounts(app.db).map((a) => a.name)).toEqual(["work"]);
    expect(listSecretNames(app.db, "forge").map((s) => s.name)).toEqual(["CLOUD_GITHUB_WORK"]);

    // Every request of the three verifications left a row, allowed.
    const rows = auditToday(app.db);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.account === "main" && r.allowed && r.purpose === "verify")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(T1);
    expect(JSON.stringify(rows)).not.toContain(T2);
  });

  test("a vendor not offered, and vercel, verify the same way", async () => {
    expect((await addAccount(app, alice, "nope", "x", T1)).ok).toBe(false);
    const v = await addAccount(app, alice, "vercel", "site", T1);
    expect(v.ok).toBe(true);
    expect(removeAccount(app, alice, "vercel", "site").ok).toBe(true);
  });

  test("no page shows a sealed token, and only admins see them", async () => {
    const login = async (username: string) =>
      ((await fetch(`${servers.url}/signin`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
        body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const cookie = await login("alice");
    for (const path of ["/settings/cloud", "/settings/cloud/audit"]) {
      const text = await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
      expect(text).not.toContain(T1);
      expect(text).not.toContain(T2);
      expect(text).toContain("GitHub");
    }
    const main = await (await fetch(`${servers.url}/settings/cloud`, { headers: { cookie } })).text();
    expect(main).toContain("Bring it home");
    expect(main).toContain("Used for nothing now");
    const bobCookie = await login("bob");
    for (const path of ["/settings/cloud", "/settings/cloud/audit"])
      expect((await fetch(`${servers.url}${path}`, { headers: { cookie: bobCookie } })).status).toBe(403);
  });

  test("a gated verify audits each request; bytes out counts the body", async () => {
    seen.length = 0;
    const f = gatedFetch(app.db, { provider: "github", account: "work" }, "verify", net.fetch);
    await f("https://api.github.com/user?x=1", { method: "POST", body: "12345" });
    expect(seen).toEqual(["https://api.github.com/user?x=1"]);
    const row = auditToday(app.db).find((r) => r.purpose === "verify" && r.bytesOut === 5);
    expect(row).toMatchObject({ allowed: true, target: "api.github.com/user" });
  });

  test("a hand-out to a run is gated and audited either way", () => {
    const who = { provider: "vercel", account: "site" };
    expect(handOut(app.db, who, "r1", undefined)).toBe(false);
    expect(handOut(app.db, who, "r2", [{ vendor: "vercel", use: "cdn", why: "site" }])).toBe(true);
    const rows = auditToday(app.db).filter((r) => r.purpose.startsWith("hand-out"));
    expect(rows.map((r) => [r.target, r.allowed]).sort()).toEqual([["run r1", false], ["run r2", true]]);
  });

  test("every provider has a vendor cloud.json can declare; aws and backblaze are s3", () => {
    for (const p of PROVIDERS) expect(CLOUD_VENDORS).toContain(VENDOR_OF[p]);
    expect(VENDOR_OF.aws).toBe("s3");
    expect(VENDOR_OF.backblaze).toBe("s3");
    const s3 = [{ vendor: "s3", use: "backup", why: "off-machine copy" }] as const;
    expect(handOut(app.db, { provider: "aws", account: "x" }, "r3", s3)).toBe(true);
    expect(handOut(app.db, { provider: "backblaze", account: "x" }, "r4", s3)).toBe(true);
    expect(handOut(app.db, { provider: "digitalocean", account: "x" }, "r5", s3)).toBe(false);
  });

  test("the runner's bar: an undeclared cloud key is refused and never opened; a declared one is granted", () => {
    const put = (name: string) => setSecret(app.db, dataDir, "forge", "", name, "sealed-value-1234567");
    put("CLOUD_AWS_X");
    put("CLOUD_GITHUB_Y");
    const asked = parseDeclaration("---\nsecrets: CLOUD_AWS_X, CLOUD_GITHUB_Y, PLAIN\n---");
    const s3 = [{ vendor: "s3", use: "backup", why: "off-machine copy" }] as const;
    const run = { id: "r6", repoId, ownerId: alice.id, actorId: alice.id };
    const reads = () => app.db.query("SELECT 1 FROM event WHERE kind = 'secret.read'").all().length;

    const before = reads();
    const none = bar(app.db, asked, "r6", []);
    expect(none.names).toEqual(["PLAIN"]);
    expect(none.refused.join()).toContain("CLOUD_AWS_X: its vendor is not declared");
    expect(none.refused.join()).toContain("CLOUD_GITHUB_Y");
    const g0 = grantSecrets(app.db, dataDir, app.bus, none, run);
    expect(g0.names).toEqual([]);
    expect(reads()).toBe(before);
    g0.release();

    const some = bar(app.db, asked, "r6", s3);
    expect(some.names).toEqual(["CLOUD_AWS_X", "PLAIN"]);
    expect(some.refused.join()).toContain("CLOUD_GITHUB_Y");
    const g1 = grantSecrets(app.db, dataDir, app.bus, some, run);
    expect(g1.names).toEqual(["CLOUD_AWS_X"]);
    g1.release();
  });

  test("the audit prunes a 91-day-old row and keeps an 89-day-old one", () => {
    const now = Date.now();
    const day = 86_400_000;
    const base = { provider: "github", account: "old", target: "", bytesOut: 0, allowed: true };
    app.db.run("DELETE FROM cloud_audit");
    app.db.query("INSERT INTO cloud_audit (at, provider, account, purpose, allowed) VALUES (?1,'github','a91','p',1)").run(new Date(now - 91 * day).toISOString());
    app.db.query("INSERT INTO cloud_audit (at, provider, account, purpose, allowed) VALUES (?1,'github','a89','p',1)").run(new Date(now - 89 * day).toISOString());
    expect(pruneAudit(app.db, now)).toBe(1);
    // Pruning also happens on write.
    app.db.query("INSERT INTO cloud_audit (at, provider, account, purpose, allowed) VALUES (?1,'github','b91','p',1)").run(new Date(now - 91 * day).toISOString());
    recordAudit(app.db, { ...base, purpose: "p" }, now);
    const left = app.db.query<{ account: string }, []>("SELECT account FROM cloud_audit ORDER BY account").all().map((r) => r.account);
    expect(left).toEqual(["a89", "old"]);
    const idx = app.db.query<{ name: string }, []>("PRAGMA index_list(cloud_audit)").all();
    expect(idx.map((i) => i.name)).toContain("cloud_audit_at");
  });

  test("the used-for line names what is declared", () => {
    expect(usedFor(undefined)).toContain("nothing");
    expect(usedFor([{ repo: "a/b", use: "cdn", why: "site" }])).toBe("Used for cdn by a/b (site).");
  });
});
