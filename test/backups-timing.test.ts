/** The backups page names its phases in Server-Timing (#3420). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let svc: SnapshotsHandle;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-backups-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  svc = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
  servers = await serve(app);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  servers.stop();
  await svc.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the backups page names session, each read and render once each", async () => {
  const res = await fetch(`${servers.url}/settings/backups`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('id="backups-live"');
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "destination", "mirror", "domains", "outcome", "snapshots", "drill", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    const part = parts.find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});

test("the live fragment adds no phases", async () => {
  const res = await fetch(`${servers.url}/settings/backups/live`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("server-timing") ?? "").not.toContain("snapshots");
});

test("with no snapshot store the page names only the reads it makes", async () => {
  const bare = mkdtempSync(join(tmpdir(), "forge-backups-timing-bare-"));
  const other = createApp({ dataDir: bare, port: 0 });
  const made = await createUser(other.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const bareServers = await serve(other);
  try {
    const r = await fetch(`${bareServers.url}/signin`, {
      method: "POST",
      headers: { origin: bareServers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const own = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${bareServers.url}/settings/backups`, { headers: { cookie: own } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No snapshots are taken");
    const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
    for (const n of ["session", "destination", "mirror", "domains", "render"])
      expect(names.filter((x) => x === n).length).toBe(1);
    for (const n of ["outcome", "snapshots", "drill"]) expect(names).not.toContain(n);
  } finally {
    bareServers.stop();
    other.close();
    rmSync(bare, { recursive: true, force: true });
  }
});
