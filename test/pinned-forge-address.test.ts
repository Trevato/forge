/**
 * A pinned forge's droplet address is read back (#8745): shown as a URL, and a
 * health check lets a failed forge recover. Tried at every door: the action,
 * the HTTP route, the MCP verb and the terminal key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, allowWrite, net as cloudNet } from "../src/actions/cloud.ts";
import { checkPinned, deployPinned, net, pinnedForges } from "../src/actions/pinned.ts";
import { readDroplet } from "../src/cloud/droplet.ts";
import { getPinned, portOf, setRemote } from "../src/core/pinned.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { Session } from "../src/tui/session.ts";
import { pinnedScreen } from "../src/tui/screens/pinned.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("pinned forge address", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let networks: unknown = { v4: [{ type: "private", ip_address: "10.0.0.2" }, { type: "public", ip_address: "203.0.113.7" }] };
  let probeStatus = 200;
  let readStatus = 200;
  const probed: string[] = [];
  const admin = () => getUserByName(app.db, "alice")!;
  const deploy = (name: string) =>
    deployPinned(app, admin(), { name, target: "digitalocean", account: "main", app: "alice/shop", source: "https://forge.example.org/trevato/forge", version: "a".repeat(40), config: { PORT: "8080" } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pinned-addr-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    cloudNet.fetch = async () => new Response(JSON.stringify({ account: { email: "a@b.c", status: "active" } }), { status: 200 });
    await addAccount(app, admin(), "digitalocean", "main", "dop_v1_9Zq4TxLm7Kp2Vb8nWcR5");
    allowWrite(app, admin(), "digitalocean", "main", true);
    net.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v2/volumes") return new Response(JSON.stringify({ volume: { id: "vol-1" } }), { status: 201 });
      if ((init?.method ?? "GET") === "GET")
        return readStatus === 200
          ? new Response(JSON.stringify({ droplet: { id: 77, status: "active", networks } }), { status: 200 })
          : new Response("{}", { status: readStatus });
      return new Response(JSON.stringify({ droplet: { id: 77 } }), { status: 202 });
    };
    net.probe = async (url) => { probed.push(url); return new Response("ok", { status: probeStatus }); };
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a deploy has no address yet; the check reads the public IPv4 back and the view carries the served URL", async () => {
    const r = await deploy("acme");
    expect(r).toMatchObject({ ok: true, value: { address: "", url: "" } });
    expect(await checkPinned(app, admin(), "acme")).toMatchObject({ ok: true, value: { address: "203.0.113.7", url: "http://203.0.113.7:8080/" } });
    const listed = pinnedForges(app, admin());
    expect(listed.ok && listed.value[0]!.url).toBe("http://203.0.113.7:8080/");
  });

  test("only a well-formed public IPv4 is taken", async () => {
    const f = async () => new Response(JSON.stringify({ droplet: { status: "new", networks } }), { status: 200 });
    networks = { v4: [{ type: "public", ip_address: "1.2.3.4; rm -rf /" }, { type: "private", ip_address: "10.0.0.2" }] };
    expect(await readDroplet(f, "t", "77")).toEqual({ status: "new", address: "" });
    networks = {};
    expect((await readDroplet(f, "t", "77")).address).toBe("");
    networks = { v4: [{ type: "public", ip_address: "203.0.113.7" }] };
    await expect(readDroplet(f, "t", "../x")).rejects.toThrow();
  });

  test("PORT is 1 to 65535, else the forge's default", () => {
    for (const [port, want] of [["8080", "8080"], ["65535", "65535"], ["0", "3000"], ["65536", "3000"], ["99999", "3000"], ["", "3000"]] as const)
      expect(portOf({ config: { PORT: port } })).toBe(want);
    expect(portOf({ config: {} })).toBe("3000");
  });

  test("the check recovers a failed forge that answers, leaves one that does not, and says so on the bus", async () => {
    const seen: any[] = [];
    const off = app.bus.subscribe((e) => { if (e.kind === "pinned.check") seen.push(e.payload); });
    setRemote(app.db, "acme", { state: "failed" });
    probeStatus = 503;
    expect(await checkPinned(app, admin(), "acme")).toMatchObject({ ok: true, value: { healthy: false, state: "failed" } });
    probeStatus = 200;
    expect(await checkPinned(app, admin(), "acme")).toMatchObject({ ok: true, value: { healthy: true, state: "running" } });
    expect(probed.at(-1)).toBe("http://203.0.113.7:8080/");
    off();
    expect(seen).toEqual([
      { name: "acme", address: "203.0.113.7", state: "failed", healthy: false },
      { name: "acme", address: "203.0.113.7", state: "running", healthy: true },
    ]);
    // A subscriber who reads the row after the event sees the recovered state.
    expect(getPinned(app.db, "acme")?.state).toBe("running");
  });

  test("the probe is audited like the other calls made for the account", () => {
    const rows = app.db.query("SELECT target FROM cloud_audit WHERE purpose = 'pinned:probe'").all() as { target: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.target).toBe("203.0.113.7:8080/");
  });

  test("a refused read is returned, not turned into 'no address'; a read-only account may still check", async () => {
    readStatus = 401;
    const refused = await checkPinned(app, admin(), "acme");
    expect(refused).toMatchObject({ ok: false });
    expect(String((refused as any).error)).toContain("401");
    readStatus = 200;
    allowWrite(app, admin(), "digitalocean", "main", false);
    expect(await checkPinned(app, admin(), "acme")).toMatchObject({ ok: true, value: { healthy: true } });
    allowWrite(app, admin(), "digitalocean", "main", true);
  });

  test("the check is the admin's, and needs a droplet", async () => {
    expect(await checkPinned(app, undefined, "acme")).toMatchObject({ ok: false });
    expect(await checkPinned(app, getUserByName(app.db, "bob")!, "acme")).toMatchObject({ ok: false });
    expect(await checkPinned(app, admin(), "nope")).toMatchObject({ ok: false, error: "No such pinned forge." });
    const fresh = await deploy("bare");
    expect(fresh.ok).toBe(true);
    setRemote(app.db, "bare", { remote: "" });
    expect(await checkPinned(app, admin(), "bare")).toMatchObject({ ok: false });
  });

  test("HTTP: admin 200, member 403 (as the sibling routes), unknown name 404, no droplet 422", async () => {
    const h = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
    const tok = createToken(app.db, admin().id, "admin", "admin").token;
    const bob = createToken(app.db, getUserByName(app.db, "bob")!.id, "admin", "admin").token;
    const post = (name: string, t?: string) =>
      fetch(`${servers.url}/api/v1/admin/pinned/${name}/check`, { method: "POST", headers: t ? h(t) : { "content-type": "application/json" }, body: "{}" });
    const ok = await post("acme", tok);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ healthy: true, url: "http://203.0.113.7:8080/" });
    expect((await post("acme", bob)).status).toBe(403);
    expect((await post("acme")).status).toBeGreaterThanOrEqual(401);
    expect((await post("nope", tok)).status).toBe(404);
    expect((await post("bare", tok)).status).toBe(422);
  });

  test("MCP: the check verb says the url; a non-admin-scope token is refused", async () => {
    const call = async (t: string, args: Record<string, unknown>) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pinned_forge", arguments: args } }),
      });
      const text = ((await res.json()) as any).result.content[0].text as string;
      return text.startsWith("{") ? JSON.parse(text) : { text };
    };
    const tok = createToken(app.db, admin().id, "admin", "admin").token;
    const done = await call(tok, { verb: "check", name: "acme" });
    expect(done.says).toBe("check acme: now " + "a".repeat(40) + ", running at http://203.0.113.7:8080/.");
    expect(done.forge).toMatchObject({ healthy: true });
    const ro = createToken(app.db, admin().id, "ro", "ro").token;
    expect((await call(ro, { verb: "check", name: "acme" })).text ?? "").not.toContain("running at");
  });

  test("terminal: c checks the forge under the cursor and redraws; a member does nothing; the row shows the url", async () => {
    const mk = (user: ReturnType<typeof admin>) => new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
    let invalidated = 0;
    const ctx = { push() {}, invalidate: () => invalidated++ } as never;
    const key = (s: { key?: (e: never) => boolean }, k: string) => s.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
    const before = probed.length;
    expect(key(pinnedScreen(mk(getUserByName(app.db, "bob")!), ctx), "c")).toBeFalsy();
    expect(probed.length).toBe(before);

    const abort = new AbortController();
    const screen = pinnedScreen(mk(admin()), ctx);
    await screen.load!(abort.signal);
    const n = invalidated;
    expect(key(screen, "c")).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(probed.length).toBe(before + 1);
    expect(invalidated).toBeGreaterThan(n);
    const list = pinnedForges(app, admin());
    expect(list.ok && list.value[0]!.url).toBe("http://203.0.113.7:8080/");
    abort.abort();
  });
});
