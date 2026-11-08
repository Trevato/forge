import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { standingHolds } from "../src/keeper/hold.ts";
import { maintenanceHtml, MAINTENANCE_HEADERS } from "../src/maintenance/page.ts";
import { prepare, resume, resumeAtBoot, status } from "../src/maintenance/service.ts";
import { inMaintenance, readState, writeState } from "../src/maintenance/state.ts";
import { HOLD_WORDS } from "../src/runs/held.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { entry, maintenanceScreen } from "../src/tui/screens/maintenance.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

test("state: missing or damaged file is not maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maint-"));
  expect(inMaintenance(dir)).toBe(false);
  await Bun.write(join(dir, "maintenance.json"), "{nope");
  expect(inMaintenance(dir)).toBe(false);
  writeState(dir, { current: { since: "2026-11-08T00:00:00Z", by: "a", reason: "", holdId: 1, backup: { ok: true, says: "x" } } });
  expect(inMaintenance(dir)).toBe(true);
  expect(readState(dir).current?.holdId).toBe(1);
  await rm(dir, { recursive: true, force: true });
});

test("page escapes the reason, refreshes, and says it is planned maintenance", () => {
  const h = maintenanceHtml({ reason: "<script>alert(1)</script>", since: "2026-11-08T00:00:00Z" });
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;script&gt;");
  expect(h).toContain('http-equiv="refresh"');
  expect(h).toContain("down for planned maintenance and will be back soon");
  expect(h).not.toContain("new hardware");
  expect(maintenanceHtml({ since: '"><b>' })).not.toContain("<b>");
});

test("vitals names maintenance as a hold", () => {
  expect(HOLD_WORDS.maintenance).toBe("planned maintenance");
});

describe("prepare and come back", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle | undefined;
  let admin: User;
  let bob: User;
  let adminRo: string;
  let adminAdmin: string;
  let bobAdmin: string;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (path: string, headers: Record<string, string>, body?: string): Promise<Response> =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: servers.url, ...headers },
      body: body ?? "{}",
    });
  const form = (path: string, cookie: string, fields: Record<string, string>): Promise<Response> =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, cookie },
      body: new URLSearchParams(fields),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-maint-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("user");
    admin = a.value;
    bob = b.value;
    adminRo = createToken(app.db, admin.id, "t", "ro").token;
    adminAdmin = createToken(app.db, admin.id, "t", "admin").token;
    bobAdmin = createToken(app.db, bob.id, "t", "admin").token;
  });
  afterAll(async () => {
    await svc?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a non-admin cannot prepare", async () => {
    const r = await prepare(app, bob, "");
    expect(r.ok).toBe(false);
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("API: a non-admin is refused, a non-admin-scope token 403, a cross-origin session 403", async () => {
    // The /api/v1/admin prefix refuses a non-admin before the handler (403); the handler's own 404 is the second lock.
    expect([403, 404]).toContain((await post("/api/v1/admin/maintenance/prepare", { cookie: await login("bob") })).status);
    expect([403, 404]).toContain((await post("/api/v1/admin/maintenance/prepare", { authorization: `Bearer ${bobAdmin}` })).status);
    expect((await post("/api/v1/admin/maintenance/prepare", { authorization: `Bearer ${adminRo}` })).status).toBe(403);
    const cookie = await login("alice");
    expect((await post("/api/v1/admin/maintenance/prepare", { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("API: a long reason is 422 and an oversized body is 413; neither prepares", async () => {
    const auth = { authorization: `Bearer ${adminAdmin}` };
    expect((await post("/api/v1/admin/maintenance/prepare", auth, JSON.stringify({ reason: "x".repeat(201) }))).status).toBe(422);
    expect((await post("/api/v1/admin/maintenance/prepare", auth, JSON.stringify({ reason: "x".repeat(10_000) }))).status).toBe(413);
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("API: resume while idle is 409", async () => {
    expect((await post("/api/v1/admin/maintenance/resume", { authorization: `Bearer ${adminAdmin}` })).status).toBe(409);
  });

  test("MCP: a non-admin is refused, a read-only token cannot prepare", async () => {
    const call = (token: string, args: Record<string, unknown>): Promise<Response> =>
      post("/mcp", { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "maintenance", arguments: args } }));
    const ro = await (await call(adminRo, { action: "prepare" })).text();
    expect(ro).toContain("forbidden");
    const nope = await (await call(bobAdmin, { action: "status" })).text();
    expect(nope).toContain("no such tool");
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("page: guest is sent to sign in, a non-admin gets not-found", async () => {
    const guest = await fetch(`${servers.url}/maintenance`, { redirect: "manual" });
    expect([302, 303, 401]).toContain(guest.status);
    const b = await fetch(`${servers.url}/maintenance`, { headers: { cookie: await login("bob") } });
    expect(b.status).toBe(404);
    expect((await form("/maintenance/prepare", await login("bob"), { confirm: "yes" })).status).not.toBe(200);
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("page: the confirm box is required to prepare", async () => {
    const cookie = await login("alice");
    const idle = await (await fetch(`${servers.url}/maintenance`, { headers: { cookie } })).text();
    expect(idle).toContain("status-rows");
    expect(idle).toContain('name="confirm"');
    await form("/maintenance/prepare", cookie, { reason: "no tick" });
    expect(inMaintenance(dataDir)).toBe(false);
  });

  test("without a backup place it holds and pauses but is not ready; the page shows facts", async () => {
    const cookie = await login("alice");
    await form("/maintenance/prepare", cookie, { reason: "moving the rack", confirm: "yes" });
    expect(inMaintenance(dataDir)).toBe(true);
    expect(standingHolds(app.db)).toHaveLength(1);
    expect(status(app).phase).toBe("draining");
    expect(status(app).says).toContain("nowhere to put a snapshot");
    const html = await (await fetch(`${servers.url}/maintenance`, { headers: { cookie } })).text();
    expect(html).toContain("moving the rack");
    expect(html).toContain("End maintenance now");
  });

  test("the terminal door: offered to admins only, and its lines say the state", () => {
    const session = (user: User) => ({ user, app, db: app.db }) as never;
    expect(entry.offered(session(admin))).toBe(true);
    expect(entry.offered(session(bob))).toBe(false);
    const screen = maintenanceScreen(session(admin), {} as never);
    expect(screen.title).toBe("Maintenance");
    expect(screen.keys.map((k) => k.help).join(" ")).toContain("end maintenance");
  });

  test("a restart of the process on the same host boot keeps what was prepared", () => {
    const boot = readState(dataDir).current?.bootId;
    resumeAtBoot(app, boot ?? "same");
    if (boot !== undefined) expect(inMaintenance(dataDir)).toBe(true);
    resumeAtBoot(app, "another-boot-id");
    expect(inMaintenance(dataDir)).toBe(false);
    expect(standingHolds(app.db)).toHaveLength(0);
    expect(status(app).last?.verified.length).toBeGreaterThan(0);
    expect(resume(app, "x").ok).toBe(false);
  });

  test("with a store it is ready once the backup is taken and nothing runs", async () => {
    svc = startSnapshots(app, dirStore(join(dataDir, "store")), { version: "t", nightly: false });
    const r = await prepare(app, admin, "");
    expect(r.ok && r.value.phase).toBe("ready");
    expect(await svc.list()).toHaveLength(1);
    resume(app, "alice");
  });
});

describe("standby", () => {
  test("answers 503 with Retry-After, and /healthz is 200", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn(["bun", "scripts/standby.ts", String(port)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MAINTENANCE_REASON: "<b>x</b>" } });
    try {
      let res: Response | undefined;
      for (let i = 0; i < 50 && res === undefined; i++) {
        res = await fetch(`http://127.0.0.1:${port}/anything`).catch(() => undefined);
        if (res === undefined) await Bun.sleep(100);
      }
      expect(res?.status).toBe(503);
      expect(res?.headers.get("retry-after")).toBe(MAINTENANCE_HEADERS["retry-after"]!);
      expect(await res?.text()).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      proc.kill();
    }
  });
});
