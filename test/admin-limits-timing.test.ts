/**
 * `GET /admin/limits` names session, limits, quotas, signup, invites and render in Server-Timing (#3443),
 * and a used invite says who joined with it and when, linked to their profile (#8080).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mintInvite, redeemInvite } from "../src/core/invites.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-admin-limits-timing-"));
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
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const signedIn = async (): Promise<string> => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
};

test("GET /admin/limits names its phases", async () => {
  const cookie = await signedIn();
  const res = await fetch(`${servers.url}/admin/limits`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("<h1>Limits</h1>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "limits", "quotas", "signup", "invites", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("a used invite says who joined with it and when", async () => {
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
  const { token } = mintInvite(app.db, alice.id);
  expect(redeemInvite(app.db, token, alice.id, Date.parse("2026-10-03T12:00:00Z") - 1)).toBe(true);
  const body = await (await fetch(`${servers.url}/admin/limits`, { headers: { cookie: await signedIn() } })).text();
  expect(body).toContain('used by <a href="/alice">alice</a> on 2026-10-03');
});

test("a used invite whose account is gone says when, with no name or link", async () => {
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
  const { token } = mintInvite(app.db, alice.id);
  expect(redeemInvite(app.db, token, "gone-account", Date.parse("2026-10-04T12:00:00Z"))).toBe(true);
  const body = await (await fetch(`${servers.url}/admin/limits`, { headers: { cookie: await signedIn() } })).text();
  expect(body).toContain(">used on 2026-10-04<");
  expect(body).not.toContain('used by <a href="/gone-account"');
});
