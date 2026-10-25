/** `/:owner/:name/looks/:env/:commit/:kind.png` names session, look and read in Server-Timing (#5371). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const COMMIT = "a".repeat(40);
let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-look-image-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const record = insertApp(app.db, { repoId: made.value.id, slug: "garden", access: "public" });
  if (!record.ok) throw new Error(record.error);
  const path = `looks/${record.value.id}/production/${COMMIT}-thumb.png`;
  mkdirSync(join(root, "looks", record.value.id, "production"), { recursive: true });
  writeFileSync(join(root, path), "png");
  recordLook(app.db, {
    appId: record.value.id,
    env: "production",
    commitOid: COMMIT,
    kind: "thumb",
    path,
    takenAs: "nobody",
  });
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET a look picture names its phases", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/alice/forge/looks/production/${COMMIT}/thumb.png`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "look", "read"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
