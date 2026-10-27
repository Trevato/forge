/**
 * Settings → Backups, "Test" and "Bring level now": posted the way the page
 * posts them (session cookie, same-origin Origin), a forge with no mirror
 * says so, an unreachable destination fails in words without leaking its
 * credentials, and only an admin on the forge's own origin may press them.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let alice = "";
let bob = "";

const login = async (username: string, password: string) => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

const post = (path: string, cookie: string, fields: Record<string, string> = {}, origin = servers.url) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { cookie, origin },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

/** The message the redirect carries in its flash cookie. */
const flash = (r: Response): { tone?: string; message: string } => {
  const raw = r.headers.getSetCookie().find((c) => c.startsWith("forge_flash=") || /flash/.test(c.split("=")[0]!));
  expect(raw).toBeDefined();
  return JSON.parse(decodeURIComponent(raw!.split(";")[0]!.split("=").slice(1).join("=")));
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-backups-buttons-"));
  app = createApp({ dataDir: root, port: 0 });
  for (const [username, password, adminIfFirst] of [
    ["alice", "a-good-passphrase", true],
    ["bob", "another-good-passphrase", false],
  ] as const) {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password,
      adminIfFirst,
    });
    if (!u.ok) throw new Error(u.error);
  }
  servers = await serve(app);
  alice = await login("alice", "a-good-passphrase");
  bob = await login("bob", "another-good-passphrase");
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a forge with no mirror says so when brought level", async () => {
  const r = await post("/settings/backups/mirror/now", alice);
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/settings/backups");
  expect(flash(r)).toEqual({ tone: "danger", message: "This forge has no mirror to bring level." });
});

test("Test against a destination it cannot reach fails in words, with no stack and no credential", async () => {
  const secret = "SECRETKEYVALUE123";
  const access = "ACCESSKEYVALUE123";
  const r = await post("/settings/backups/test", alice, {
    endpoint: "http://store.invalid",
    bucket: "nowhere-bucket",
    region: "us-east-1",
    access_key: access,
    secret_key: secret,
  });
  expect(r.status).toBe(303);
  const f = flash(r);
  expect(f.tone).toBe("danger");
  expect(f.message).toMatch(/^Could not list /);
  for (const leak of [secret, access, "    at ", "node_modules"]) expect(f.message).not.toContain(leak);
  const page = await (await fetch(`${servers.url}/settings/backups`, { headers: { cookie: alice } })).text();
  expect(page).not.toContain(secret);
  expect(page).not.toContain(access);
}, 90_000);

test("Test with nothing typed and nothing sealed says there is nothing to test", async () => {
  const f = flash(await post("/settings/backups/test", alice));
  expect(f.tone).toBe("danger");
  expect(f.message.length).toBeGreaterThan(0);
});

for (const path of ["/settings/backups/test", "/settings/backups/mirror/now"]) {
  test(`${path}: a non-admin, an anonymous visitor and a cross-origin post are refused`, async () => {
    const asBob = await post(path, bob);
    expect(asBob.status).toBe(404);
    expect(asBob.headers.getSetCookie().join(";")).not.toMatch(/flash/);

    const anon = await post(path, "");
    expect(anon.status).not.toBe(200);
    expect(anon.headers.getSetCookie().join(";")).not.toMatch(/flash/);

    const cross = await post(path, alice, {}, "https://evil.example");
    expect(cross.status).toBe(403);
    expect(cross.headers.getSetCookie().join(";")).not.toMatch(/flash/);
  });
}
