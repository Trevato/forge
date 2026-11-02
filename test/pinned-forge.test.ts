/**
 * A pinned forge (#8697): deployed once, changed only by an explicit Update
 * that records who and when, rolled back in one action, and never holding a
 * credential in a row, an event or the boot script. Every other way to move
 * its version or config is tried here and refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, allowWrite, net as cloudNet } from "../src/actions/cloud.ts";
import { deployPinned, net, pinnedForges, rollbackPinned, updatePinned } from "../src/actions/pinned.ts";
import { bootConfig } from "../src/cloud/droplet.ts";
import { TARGETS } from "../src/cloud/targets.ts";
import { changesOf, checkConfig, getPinned } from "../src/core/pinned.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "dop_v1_9Zq4TxLm7Kp2Vb8nWcR5";
const V1 = "a".repeat(40);
const V2 = "b".repeat(40);
const SOURCE = "https://forge.example.org/trevato/forge";

describe("pinned forge", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  const calls: { method: string; url: string; auth: string | null; body: any }[] = [];
  let failNext = false;

  const admin = () => getUserByName(app.db, "alice")!;
  const input = (over: Record<string, unknown> = {}) => ({
    name: "acme", target: "digitalocean", account: "main", app: "alice/shop", source: SOURCE, version: V1, config: { PUBLIC_NAME: "Acme" }, ...over,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pinned-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    cloudNet.fetch = async () => new Response(JSON.stringify({ account: { email: "a@b.c", status: "active" } }), { status: 200 });
    const added = await addAccount(app, admin(), "digitalocean", "main", TOKEN);
    if (!added.ok) throw new Error(String(added.error));
    net.fetch = async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (failNext) { failNext = false; return new Response("{}", { status: 500 }); }
      if (u.pathname === "/v2/volumes") return new Response(JSON.stringify({ volume: { id: "vol-1" } }), { status: 201 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ droplet: { id: 1000 + calls.length } }), { status: 202 });
    };
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a deploy needs a cloud account that may write", async () => {
    const r = await deployPinned(app, admin(), input());
    expect(r).toMatchObject({ ok: false });
    expect(String((r as any).error)).toContain("read-only");
    expect(calls).toHaveLength(0);
    // The attempt is recorded, and the forge says it failed rather than running.
    expect(getPinned(app.db, "acme")?.state).toBe("failed");
  });

  test("deploy makes a volume, then a droplet on it; the token is a header, never in a body or the boot script", async () => {
    app.db.run("DELETE FROM pinned_forge");
    allowWrite(app, admin(), "digitalocean", "main", true);
    const r = await deployPinned(app, admin(), input());
    expect(r.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /v2/volumes", "POST /v2/droplets"]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const droplet = calls[1]!.body;
    expect(droplet.volumes).toEqual(["vol-1"]);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(TOKEN);
    expect(droplet.user_data).toContain(`checkout --detach ${V1}`);
    expect(droplet.user_data).toContain("FORGE_APP_DATA=/mnt/forge_acme_data");
    const p = getPinned(app.db, "acme")!;
    expect(p).toMatchObject({ state: "running", volume: "vol-1" });
    const events = JSON.stringify(app.db.query("SELECT payload FROM event WHERE kind LIKE 'pinned.%'").all());
    expect(events).not.toContain(TOKEN);
    expect(JSON.stringify(pinnedForges(app, admin()))).not.toContain(TOKEN);
  });

  test("a pinned forge has no crew and no automatic release, and the schema keeps it so", () => {
    const v = pinnedForges(app, admin());
    expect(v.ok && v.value[0]).toMatchObject({ crew: false, autoRelease: false });
    expect(() => app.db.run("UPDATE pinned_forge SET crew = 1")).toThrow();
    expect(() => app.db.run("UPDATE pinned_forge SET auto_release = 1")).toThrow();
  });

  test("version and config move only through Update: every other way is refused", async () => {
    const before = getPinned(app.db, "acme")!;
    // Straight SQL, as any other code path in the forge would try.
    expect(() => app.db.run("UPDATE pinned_forge SET version = ?1", [V2])).toThrow(/explicit Update/);
    expect(() => app.db.run("UPDATE pinned_forge SET config = '{}'")).toThrow(/explicit Update/);
    // Forging a change id that points at no matching change.
    expect(() => app.db.run("UPDATE pinned_forge SET version = ?1, change_id = change_id + 1", [V2])).toThrow(/explicit Update/);
    // A change recorded for one version cannot authorize another.
    const c = app.db.query("INSERT INTO pinned_change (pinned_id, kind, from_version, to_version, from_config, to_config, by, at) VALUES (?1,'update',?2,?3,'{}','{}','x','now')").run(before.id, V1, V2);
    expect(() => app.db.run("UPDATE pinned_forge SET version = ?1, config = ?2, change_id = ?3", ["c".repeat(40), "{}", Number(c.lastInsertRowid)])).toThrow(/explicit Update/);
    // A deploy-kind change cannot be replayed as an update.
    const d = app.db.query("SELECT id FROM pinned_change WHERE kind = 'deploy'").get() as { id: number };
    expect(() => app.db.run("UPDATE pinned_forge SET version = ?1, change_id = ?2", [V2, d.id])).toThrow();
    // History cannot be rewritten or deleted.
    expect(() => app.db.run("UPDATE pinned_change SET by = 'someone'")).toThrow(/history/);
    expect(() => app.db.run("DELETE FROM pinned_change")).toThrow(/history/);
    expect(getPinned(app.db, "acme")!.version).toBe(before.version);
    // Not an admin, not a thing.
    const bob = getUserByName(app.db, "bob");
    expect(await updatePinned(app, bob, "acme", { version: V2 })).toEqual({ ok: false, error: "not_found" });
    expect(await rollbackPinned(app, undefined, "acme")).toEqual({ ok: false, error: "not_found" });
    expect(getPinned(app.db, "acme")!.version).toBe(V1);
  });

  test("Update records who and when, replaces the droplet and keeps the volume", async () => {
    calls.length = 0;
    const r = await updatePinned(app, admin(), "acme", { version: V2, config: { PUBLIC_NAME: "Acme Ltd" } });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([expect.stringMatching(/^DELETE \/v2\/droplets\/\d+$/), "POST /v2/droplets"]);
    expect(calls[1]!.body.volumes).toEqual(["vol-1"]);
    expect(calls[1]!.body.user_data).toContain(`checkout --detach ${V2}`);
    const [latest] = changesOf(app.db, getPinned(app.db, "acme")!.id);
    expect(latest).toMatchObject({ kind: "update", fromVersion: V1, toVersion: V2, by: admin().id });
    expect(Date.parse(latest!.at)).toBeGreaterThan(0);
  });

  test("Update refuses an unsafe version, secret-looking config, and a no-op", async () => {
    calls.length = 0;
    for (const version of ["main", "--upload-pack=x", `${V1}; rm -rf /`, "v1.2"])
      expect(await updatePinned(app, admin(), "acme", { version })).toMatchObject({ ok: false });
    expect(await updatePinned(app, admin(), "acme", { config: { API_TOKEN: "x" } })).toMatchObject({ ok: false });
    expect(await updatePinned(app, admin(), "acme", { config: { A: "$(id)" } })).toMatchObject({ ok: false });
    expect(await updatePinned(app, admin(), "acme", {})).toMatchObject({ ok: false, error: "That is what it runs already." });
    expect(calls).toHaveLength(0);
    expect(getPinned(app.db, "acme")!.version).toBe(V2);
  });

  test("Rollback is one action to the previous version and is recorded", async () => {
    const r = await rollbackPinned(app, admin(), "acme");
    expect(r.ok && r.value).toMatchObject({ version: V1, config: { PUBLIC_NAME: "Acme" } });
    const [latest] = changesOf(app.db, getPinned(app.db, "acme")!.id);
    expect(latest).toMatchObject({ kind: "rollback", fromVersion: V2, toVersion: V1 });
  });

  test("a cloud failure leaves the change recorded and the forge marked failed", async () => {
    failNext = true;
    const r = await updatePinned(app, admin(), "acme", { version: V2 });
    expect(r).toMatchObject({ ok: false });
    expect(getPinned(app.db, "acme")).toMatchObject({ version: V2, state: "failed" });
    expect(changesOf(app.db, getPinned(app.db, "acme")!.id)[0]).toMatchObject({ kind: "update", toVersion: V2 });
  });

  test("a forge with only its first version has nothing to roll back to", async () => {
    app.db.run("UPDATE pinned_forge SET name = 'old' WHERE name = 'acme'");
    const r = await deployPinned(app, admin(), input({ name: "fresh" }));
    expect(r.ok).toBe(true);
    expect(await rollbackPinned(app, admin(), "fresh")).toMatchObject({ ok: false });
  });

  test("Cloudflare and Vercel are refused with a reason; AWS and Azure are named as not written", async () => {
    for (const target of ["cloudflare", "vercel", "aws", "azure"]) {
      const r = await deployPinned(app, admin(), input({ name: `x-${target}`, target }));
      expect(r.ok).toBe(false);
    }
    expect(TARGETS.map((t) => t.id)).toEqual(["digitalocean", "aws", "azure", "cloudflare", "vercel"]);
    expect(getPinned(app.db, "x-vercel")).toBeUndefined();
  });

  test("boot script and config hold no shell metacharacter that user text could smuggle", () => {
    expect(checkConfig({ A: "x\nB=1" }).ok).toBe(false);
    expect(checkConfig({ A: 'x"y' }).ok).toBe(false);
    expect(checkConfig({ "a b": "x" }).ok).toBe(false);
    const script = bootConfig({ name: "acme", source: SOURCE, version: V1, config: { A: "b" } });
    expect(script).toContain("A=b");
    expect(script.startsWith("#cloud-config")).toBe(true);
  });

  test("HTTP: the admin routes list, update and roll back; a member sees nothing", async () => {
    const tok = createToken(app.db, admin().id, "admin", "admin").token;
    const bob = createToken(app.db, getUserByName(app.db, "bob")!.id, "admin", "admin").token;
    const h = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
    const list = await fetch(`${servers.url}/api/v1/admin/pinned`, { headers: h(tok) });
    expect(list.status).toBe(200);
    const body = (await list.json()) as any;
    expect(body.targets).toHaveLength(5);
    expect(body.items.length).toBeGreaterThan(0);
    expect((await fetch(`${servers.url}/api/v1/admin/pinned`, { headers: h(bob) })).status).toBeGreaterThanOrEqual(403);
    const up = await fetch(`${servers.url}/api/v1/admin/pinned/fresh/update`, { method: "POST", headers: h(tok), body: JSON.stringify({ version: V2 }) });
    expect(up.status).toBe(200);
    expect(((await up.json()) as any).version).toBe(V2);
    const back = await fetch(`${servers.url}/api/v1/admin/pinned/fresh/rollback`, { method: "POST", headers: h(tok), body: "{}" });
    expect(((await back.json()) as any).version).toBe(V1);
    const bad = await fetch(`${servers.url}/api/v1/admin/pinned/fresh/update`, { method: "POST", headers: h(tok), body: JSON.stringify({ version: "main" }) });
    expect(bad.status).toBe(422);
    const missing = await fetch(`${servers.url}/api/v1/admin/pinned/nope/rollback`, { method: "POST", headers: h(tok), body: "{}" });
    expect(missing.status).toBe(404);
  });

  test("MCP pinned_forge lists and updates for an admin-scope token", async () => {
    const tok = createToken(app.db, admin().id, "admin", "admin").token;
    const call = async (args: Record<string, unknown>) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pinned_forge", arguments: args } }),
      });
      const text = ((await res.json()) as any).result.content[0].text as string;
      return text.startsWith("{") ? JSON.parse(text) : { text };
    };
    expect((await call({ verb: "list" })).items.length).toBeGreaterThan(0);
    expect((await call({ verb: "update", name: "fresh", version: V2 })).says).toContain(V2);
    expect((await call({ verb: "update", name: "fresh", version: "nope" })).text).toContain("full 40-character");
  });
});
