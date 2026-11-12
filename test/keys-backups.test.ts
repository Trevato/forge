/** The backups list joins the shell's j/k row traversal: one data-nav per snapshot row, none on the empty list. */
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
  root = mkdtempSync(join(tmpdir(), "forge-keys-backups-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
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
}, 60_000);

afterAll(async () => {
  servers.stop();
  await svc.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const page = async () => (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/g;

test("with no snapshot yet the list draws no data-nav row", async () => {
  const text = await page();
  expect(text).toContain("None yet");
  expect(text).not.toMatch(NAV);
});

test("each snapshot row is one data-nav row", async () => {
  await svc.now();
  const text = await page();
  const list = text.slice(text.indexOf('id="snapshots"'));
  expect(list.slice(0, list.indexOf("</ul>")).match(NAV)?.length).toBe(1);
});
